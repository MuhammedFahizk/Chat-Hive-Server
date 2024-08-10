import { TOTP } from 'totp-generator';
import { Otp, User } from '../model/User.js';
import { OAuth2Client } from 'google-auth-library';
import sendOtpUserOtp from '../services/nodeMailer.js';

import cloudinary from 'cloudinary';
import { ObjectId } from 'mongodb';
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
import argon2 from 'argon2';
import Posts from '../model/Posts.js';
import { deleteImageCloudinary } from '../services/deleteImageCloudinary.js';
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const userValidateEmailHelper = async (user) => {
  try {
    const existingUser = await User.findOne({
      $or: [{ email: user.email }, { userName: user.userName }],
    });
    if (existingUser) {
      if (existingUser.email === user.email) {
        throw new Error('Email already exists');
      }
      throw new Error('Username already exists');
    }


    const otpSecret = 'JBSWY3DPEHPK3PXP';
    const { otp, expires } = TOTP.generate(otpSecret);

    let existingOtp = await Otp.findOne({ email: user.email });
    if (existingOtp) {
      existingOtp.otp = otp;
      existingOtp.expires = expires;
      await existingOtp.save();
    } else {
      existingOtp = new Otp({ otp, expires, email: user.email });
      await existingOtp.save();
    }

    await sendOtpUserOtp(user.email, otp); // Ensure otp is sent properly

    return { message: 'OTP sent successfully', user: user };
  } catch (error) {
    console.error('Error in user validation:', error);
    throw error;
  }
};

const userSignUpHelper = async (user) => {
  try {
    // Check if email or username already exists
    const existingUser = await User.findOne({
      $or: [{ email: user.email }, { userName: user.userName }],
    });
    if (existingUser) {
      if (existingUser.email === user.email) {
        throw new Error('Email already exists');
      }
      throw new Error('Username already exists');
    }

    const otpInput = user.otp;
    const otpRecord = await Otp.findOne({ email: user.email });

    if (!otpRecord) {
      throw new Error('OTP not found');
    }
    if (otpRecord.otp !== otpInput) {
      throw new Error('Invalid OTP');
    }
    const hashPassword = await argon2.hash(user.password);
    // Save new user
    const newUser = new User({
      ...user,
      password: hashPassword,
    });
    const savedUser = await newUser.save();
    await Otp.deleteOne({ email: user.email });
    return savedUser;
  } catch (error) {
    console.error('Error saving user:', error);
    throw error; // Propagate the error up to the caller
  }
};

const userLoginHelper = async (user) => {
  return new Promise((resolve, reject) => {
    User.findOne({ email: user.email })
      .then(async (existingUser) => {
        if (!existingUser) {
          reject(new Error('Invalid credentials'));
        }
        if (existingUser.isBlocked) {
          reject(new Error('Your account is blocked'));
        }
        const isPasswordValid = await argon2.verify(existingUser.password, user.password);
        if (isPasswordValid) {
          resolve(existingUser);
        } else {
          reject(new Error('Invalid credentials'));
        }
      })
      .catch((err) => {
        console.error('Database query failed', err); // Log the actual error for debugging
        reject(new Error(`Database query failed: ${  err.message}`)); // Pass the actual error message
      });
  });
};


const userGoogleLoginHelper = async (credential) => {
  // Directly use the credential as the ID token since it's the entire JWT string
  const idToken = credential; // No need to decode or extract further

  // Validate the ID token is present
  if (!idToken) {
    throw new Error('ID token is missing');
  }

  try {
    const response = await client.verifyIdToken({
      idToken: idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    return response.payload;
  } catch (error) {
    console.error('Error verifying ID token:', error);
    throw error; // Rethrow the error to be caught by the calling function
  }
};

const googleLoginUser = async (user) => {
  return new Promise((resolve, reject) => {
    const { email } = user;
    User.findOne({ email })
      .then((user) => {
        if (user) {
          if (user.isBlocked) {
            reject(new Error('Your account is blocked. Please contact support.'));
          } else {
            resolve(user);
          }
        } else {
          reject(new Error('User not found'));
        }
      })
      .catch((error) => {
        reject(new Error(`Database query failed: ${  error.message}`));
      });
  });
};


const logoutHelper = async (refreshToken) => {
  try {
    const user = await User.findOne({ token: refreshToken });
    if (user) {
      user.token = null;
      await user.save();
      return user;
    } else {
      throw new Error('User not found');
    }
  } catch (error) {
    throw new Error(error.message);
  }
};

const findSuggestion = async (id) => {
  try {
    const user = await User.findById(id).populate('following').populate('followers');
  
    if (!user) {
      // Handle the case where user is not found
      return { users: [], user: null };
    }
  
    // Ensure `following` is an array if it's null or undefined
    const following = user.following || [];
    const followingIds = following.map(follow => follow._id);
  
    // Find users followed by the users in the `following` list, excluding current user and already followed users
    let users = await User.aggregate([
      {
        $match: {
          _id: { $ne: id }
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: 'following',
          foreignField: '_id',
          as: 'suggestedUsers'
        }
      },
      {
        $unwind: '$suggestedUsers'
      },
      {
        $match: {
          'suggestedUsers._id': { $ne: id },
          'suggestedUsers._id': { $nin: followingIds }
        }
      },
      {
        $group: {
          _id: null,
          suggestedUsers: { $addToSet: '$suggestedUsers' }
        }
      },
      {
        $project: {
          _id: 0,
          suggestedUsers: 1
        }
      },
      {
        $limit: 10
      }
    ]);

    users = users.length > 0 ? users[0].suggestedUsers : [];

    // If fewer than 10 users are suggested, fill up with random users
    if (users.length < 10) {
      const additionalUsers = await User.aggregate([
        {
          $match: {
            _id: { $ne: id },
            _id: { $nin: followingIds.concat(users.map(u => u._id)) }
          }
        },
        {
          $sample: { size: 10 - users.length }
        }
      ]);
      users = users.concat(additionalUsers);
    }

    return { users, user };
  } catch (error) {
    console.error('Error finding user suggestions:', error);
    throw error;
  }
};


const followingHelper = (_id, userId) => {
  return new Promise(async (resolve, reject) => {
    try {
      const follower = await User.findById(_id);
      const following = await User.findById(userId);

      if (!follower && !following) {
        throw new Error('User not found');
      }
      following.followers.push(_id);
      // Add userId to the following array
      follower.following.push(userId);
      
      // Save the updated user document
      await follower.save();
      await following.save();
      resolve(following);
    } catch (error) {
      reject(error);
    }
  });
};

const unFollowingHelper = async (_id, userId) => {
  try {
    const follower = await User.findById(_id);
    const following = await User.findById(userId);

    if (!follower || !following) {
      throw new Error('User not found');
    }
    following.followers = following.followers.filter(followerId => followerId.toString() !== _id.toString());
    follower.following = follower.following.filter(followingId => followingId.toString() !== userId.toString());


    await follower.save();
    await following.save();

    return { message: 'Un follow successful' };
  } catch (error) {
    console.error('Error in unFollowingHelper:', error);
    throw error; // Rethrow to allow caller to handle or log the error further
  }
};

const profileHelper = (id, _id) => {
  return new Promise(async (resolve, reject) => {
    try {
      const profile = await User.findById(id)
        .populate('followers')
        .populate('following');
      const user = await User.findById(_id)
        .populate('followers')
        .populate('following');
      const post = await Posts.find({ author: id })
        .populate('author')
        .populate({
          path: 'comments.author',
          select: 'userName profilePicture'
        });
      if (!user) throw new Error('User not found');
      if (!profile) throw new Error('Profile not found');

      resolve({ user, profile, post  });
    } catch (error) {
      reject(error);
    }
  });
};

const userProfileHelper = async(id) => {
  return new Promise(async (resolve, reject) => {
    try {

      const profile = await User.findById(id)
        .populate('followers')
        .populate('following');
      const user = await User.findById(id)
        .populate('followers')
        .populate('following');
      const post = await Posts.find({ author: id })
        .populate('author')
        .populate({
          path: 'comments.author',
          select: 'userName profilePicture'
        });
      if (!profile) throw new Error('User not found');

      resolve({ profile, post, user });
    } catch (error) {
      console.error(error);
      reject(error);
    }
  });
};
const searchHelper = async (id, value, item, offset) => {
  offset = parseInt(offset, 10);

  return new Promise(async (resolve, reject) => {
    let queryResult;

    try {
      switch (item) {
        case 'users':
          const usersPipeline = [
            {
              $match: {
                $or: [
                  { userName: { $regex: value, $options: 'i' }},
                  { email: { $regex: value, $options: 'i' } }
                ]
              }
            }
          ];

          if (offset > 0) {
            usersPipeline.push({ $skip: offset });
          }

          usersPipeline.push({ $limit: 10 });

          queryResult = await User.aggregate(usersPipeline);
          break;

        case 'blogs':
          queryResult = await Posts.find({ 
            $or:[
              { title: { $regex: value, $options: 'i' } },
              {hashTags: { $regex: value, $options: 'i'}}
            ]
          })
            .skip(offset)
            .limit(10)
            .populate('author');
          break;

        case 'images':
          queryResult = await Posts.find({
            hashTags: { $elemMatch: { $regex: value, $options: 'i' } }
          })
            .skip(offset)
            .limit(10)
            .populate('author')
            .populate({
              path: 'comments.author',
              select: 'userName profilePicture'
            });
          break;

        default:
          throw new Error(`Unsupported item: ${item}`);
      }

      resolve(queryResult);
    } catch (error) {
      reject(error);
    }
  });
};


const uploadProfileHelper = async (id, file) => {
  return new Promise(async (resolve, reject) => {
    try {
      const result = await cloudinary.uploader.upload(file.path, {
        folder: 'Social Media'
      });
      const profile = await User.findByIdAndUpdate(id, {
        profilePicture: result.secure_url
      }, { new: true }); // Assuming you want the updated document
      resolve(profile);
    } catch (error) {
      reject(error);
    }
  });
};

const createPostHelper = async (data, content, id) => {
  try {
    const hashTags = data.hashTag.match(/#[\w]+/g) || [];

    // Create a new post object
    const post = new Posts({
      author: id,
      content,
      hashTags, // Assign the extracted hashtags to the hashTags field
      ...data
    });

    // Save the post to the database
    const savedPost = await post.save();
    return savedPost;
  } catch (error) {
    console.error(error);
    throw new Error(error.message);
  }
};

const createStoryHelper = async (data, content, id) => {
  try {
    const post = {
      imageUrl: data.imageUrl,
    };

    // Find the user by ID
    const user = await User.findById(id);
    
    if (!user) {
      throw new Error('User not found');
    }

    // Push the new story post to the story array
    user.story.push(post);

    // Save the user document
    const savedUser = await user.save();
    return savedUser;
  } catch (error) {
    console.error(error);
    throw new Error(error.message);
  }
};
const fetchPostHelper = async (id) => {
  try {
    // Ensure this line is correctly implemented based on your database setup
    const post = await Posts.findById(id).populate('author')
      .populate({
        path: 'comments.author',
        select: 'userName profilePicture'
      });
    if (post) {
      post.comments.sort((a, b) => b.timestamps - a.timestamps);
    }
    return post;
  } catch (error) {
    console.error(error); // Log the error for debugging purposes
    throw error; // Rethrow the error to be caught by the calling function
  }
};
const unLikePostHelper = (id, _id) => {
  return new Promise((resolve, reject) => {
    Posts.updateOne(
      { _id: id },
      { $pull: { likes: _id } }
    )
      .then(result => {
        if (result.matchedCount === 0) {
          // No matching document found
          return reject(new Error('No matching post found to unlike'));
        }
        resolve(result);
      })
      .catch(error => {
        reject(error);
      });
  });
};


const likePostHelper = async (id, _id) => {
  try {
    // Check if the user has already liked the post
    const post = await Posts.findOne({ _id: id, likes: _id });

    if (post) {
      // If the post is found with the user's ID in likes, reject the promise
      return Promise.reject(new Error('User has already liked this post'));
    }

    // If the user has not liked the post, proceed to add the like
    const result = await Posts.updateOne(
      { _id: id },
      { $push: { likes: _id } }
    );

    if (result.matchedCount === 0) {
      // No matching document found
      return Promise.reject(new Error('No matching post found to like'));
    }

    return result;
  } catch (error) {
    return Promise.reject(error);
  }
};
const userCreateComment = async (postId, userId, commentContent) => {
  try {

    // Update the post by pushing a new comment object into the comments array
    const result = await Posts.findOneAndUpdate(
      { _id: postId },
      { $push: { comments: { author: userId, content: commentContent } } },
      { new: true}
    )
      .populate('author')
      .populate({
        path: 'comments.author',
        select: 'userName profilePicture'
      });

    // Check if a document matched the query
    if (result.matchedCount === 0) {
      throw new Error('No matching post found to add the comment');
    }
    return result;
  } catch (error) {
    // Handle errors and reject the promise with the error message
    throw new Error(error.message);
  }
};

const fetchPostsHelper = async (heading, offset, id) => {
  let postItems = [];
  offset = parseInt(offset);
  try {
    const user = await User.findById(id);
    if (!user && heading === 'Friends') throw new Error('User not found');

    switch (heading) {
      case 'Recent':
        postItems = await Posts.find()
          .sort({ createdAt: -1 })
          .skip(offset)
          .limit(5)
          .populate('author')
          .populate({
            path: 'comments.author',
            select: 'userName profilePicture'
          });
        break;

      case 'Friends':
        postItems = await Posts.find({ author: { $in: user.following } })
          .sort({ createdAt: -1 })
          .skip(offset)
          .limit(5)
          .populate('author')
          .populate({
            path: 'comments.author',
            select: 'userName profilePicture'
          });
        break;

      case 'Popular':
        postItems = await Posts.aggregate([
          {
            $lookup: {
              from: 'users',
              localField: 'author',
              foreignField: '_id',
              as: 'author'
            }
          },
          { $unwind: '$author' },
          {
            $addFields: {
              totalLikes: { $size: { $ifNull: ['$likes', []] } },
              totalComments: { $size: { $ifNull: ['$comments', []] } }
            }
          },
          {
            $addFields: {
              engagementScore: {
                $add: [
                  { $multiply: ['$totalLikes', 1] },
                  { $multiply: ['$totalComments', 3] }
                ]
              }
            }
          },
          {
            $addFields: {
              commentsAuthorArray: {
                $cond: {
                  if: { $isArray: '$comments.author' },
                  then: '$comments.author',
                  else: []
                }
              }
            }
          },
          {
            $lookup: {
              from: 'users',
              let: { commentAuthors: '$commentsAuthorArray' },
              pipeline: [
                { $match: { $expr: { $in: ['$_id', '$$commentAuthors'] } } },
                { $project: { userName: 1, profilePicture: 1 } }
              ],
              as: 'commentAuthors'
            }
          },
          {
            $addFields: {
              comments: {
                $map: {
                  input: '$comments',
                  as: 'comment',
                  in: {
                    content: '$$comment.content',
                    author: {
                      $arrayElemAt: [
                        {
                          $filter: {
                            input: '$commentAuthors',
                            cond: { $eq: ['$$this._id', '$$comment.author'] }
                          }
                        },
                        0
                      ]
                    },
                    createdAt: '$$comment.createdAt'
                  }
                }
              }
            }
          },
          {
            $group: {
              _id: '$_id',
              author: { $first: '$author' },
              content: { $first: '$content' },
              imageUrl: { $first: '$imageUrl' },
              title: { $first: '$title' },
              body: { $first: '$body' },
              hashTag: { $first: '$hashTag' },
              likes: { $first: '$likes' },
              comments: { $first: '$comments' },
              totalLikes: { $first: '$totalLikes' },
              totalComments: { $first: '$totalComments' },
              engagementScore: { $first: '$engagementScore' },
              createdAt: { $first: '$createdAt' }
            }
          },
          {
            $sort: {
              engagementScore: -1,
              createdAt: -1
            }
          },
          { $skip: offset },
          { $limit: 5 }
        ]);
        break;
      
      default:
        throw new Error(`Unsupported heading: ${heading}`);
    }

    return postItems;
  } catch (error) {
    console.error('Error fetching post helper:', error);
    throw error;
  }
};
const deletePostHelper = async (id, _id) => {
  try {
    const post = await Posts.findById(id);
    console.log(post);
    if (!post) {
      throw {  error: 'Post not found' };
    }

    if (post.author.toString() !== _id) {
      throw { error: 'You are not authorized to delete this post' };
    }

    // await deleteImageCloudinary(post.imageUrl);
    await Posts.findByIdAndDelete(id)
      .then((res) => {
        console.log(res,'sfdf');
        return { success: 'Post deleted successfully',res };
      })
      .catch((err) => {
        console.error('Error deleting post:', err);
        return { error: 'Error deleting post' };
      });
  } catch (error) {
    return { error: 'An error occurred while deleting the post',error };
  }
};

const getFollowersHelper = async (userId, offset = 0,query) => {
  try {
    const user = await User.findById(userId).populate({

      path: 'followers',
      match: query.trim() === '' ? {} : {
        userName: { $regex: query, $options: 'i' }
      },
      options: {
        skip: Number(offset),
        limit: 10,
        select: 'userName profilePicture'
      }
    });

    if (!user) {
      throw new Error('User not found');
    }
    const totalCount = await User.aggregate([
      { $match: { _id: new ObjectId(userId) } },
      { $unwind: '$followers' },
      {
        $lookup: {
          from: 'users',
          localField: 'followers',
          foreignField: '_id',
          as: 'followersDetails'
        }
      },
      { $unwind: '$followersDetails' },
      {
        $match: query.trim() === '' ? {} : {
          'followersDetails.userName': { $regex: query, $options: 'i' }
        }
      },
      { $count: 'totalCount' }
    ]).then(result => (result.length > 0 ? result[0].totalCount : 0));

    return { connections: user.followers, totalCount };
  } catch (error) {
    throw new Error(error.message);
  }
};

const getFollowingsHelper = async (userId, offset = 0, query) => {
  try {
    const user = await User.findById(userId).populate({

      path: 'following',
      match: query.trim() === '' ? {} : {
        userName: { $regex: query, $options: 'i' }
      },
      options: {
        skip: Number(offset),
        limit: 10,
        select: 'userName profilePicture'
      }
    });

    if (!user) {
      throw new Error('User not found');
    }
    const totalCount = await User.aggregate([
      { $match: { _id: new ObjectId(userId) } },
      { $unwind: '$following' },
      {
        $lookup: {
          from: 'users',
          localField: 'following',
          foreignField: '_id',
          as: 'followingDetails'
        }
      },
      { $unwind: '$followingDetails' },
      {
        $match: query.trim() === '' ? {} : {
          'followingDetails.userName': { $regex: query, $options: 'i' }
        }
      },
      { $count: 'totalCount' }
    ]).then(result => (result.length > 0 ? result[0].totalCount : 0));

    return { connections: user.following, totalCount};
  } catch (error) {
    console.error(error);
    throw new Error(error.message);
  }
};

const deleteCommentHelper = (commentId, postId, _id) => {
  return new Promise(async (resolve, reject) => {
    try {
      const updatedPost = await Posts.findOneAndUpdate(
        { _id: postId },
        { $pull: { comments: { _id: commentId } } },
        { new: true }
      ).populate('author')
        .populate({
          path: 'comments.author',
          select: 'userName profilePicture'
        });

      if (!updatedPost) {
        return reject(new Error('Post not found'));
      }

      resolve(updatedPost);
    } catch (error) {
      reject(error);
    }
  });
};

const getFreshStoriesHelper = async (userId) => {
  try {
    // Retrieve the current user's information
    const currentUser = await User.findById(userId).lean();

    // Define a helper function to filter stories for freshness
    const filterFreshStories = (stories) => {
      const twentyFourHoursInMilliseconds = 1000 * 60 * 60 * 24;
      return stories.filter(story => story.createdAt.getTime() > Date.now() - twentyFourHoursInMilliseconds);
    };

    // Perform the aggregation to get users who are either followed by the current user, are following the current user, or the current user themselves
    let users = await User.aggregate([
      { $unwind: '$story' },
      {
        $match: {
          $or: [
            { 'followers': new ObjectId(currentUser._id) },
            { 'following': new ObjectId(currentUser._id) },
            { '_id': new ObjectId(currentUser._id) }
          ]
        }
      },
      { $sort: { 'story.createdAt': -1 } },
      {
        $lookup: {
          from: 'users', // The collection name in MongoDB
          localField: 'story.views.userId',
          foreignField: '_id',
          as: 'story.views.userDetails'
        }
      },
      {
        $group: {
          _id: '$_id',
          userName: { $first: '$userName' },
          email: { $first: '$email' },
          isBlocked: { $first: '$isBlocked' },
          bio: { $first: '$bio' },
          profilePicture: { $first: '$profilePicture' },
          followers: { $first: '$followers' },
          following: { $first: '$following' },
          story: { $push: '$story' },
        }
      }
    ]);

    // Filter for fresh stories and remove users with no fresh stories
    const freshStoryUsers = users.map(user => ({
      ...user,
      story: filterFreshStories(user.story)
    })).filter(user => user.story.length > 0);

    return freshStoryUsers;
  } catch (error) {
    console.error('Error fetching fresh stories:', error);
    throw error;
  }
};

const incrementViewerCountHelper = async (userId, storyId, authorId) => {
  try {
    // Find the author by ID and populate the story field
    const user = await User.findById(authorId).populate('story.views.userId');
    if (!user) {
      return { error: 'Author not found' };
    }

    // Find the specific story within the user's story array
    const story = user.story.id(storyId);
    if (!story) {
      return { error: 'Story not found' };
    }

    // Check if the user has already viewed the story
    if (!story.views.some(view => view.userId.equals(userId))) {
      // Add the user to the list of viewers
      story.views.push({ userId, viewedAt: new Date() });
      await user.save(); // Save the updated user document
    }

    // Return the count of viewers for the story
    return {  story };
  } catch (error) {
    console.error('Error in incrementViewerCountHelper:', error);
    return { error: 'Server error' };
  }
};

const fetchProfileStoresHelper = (userId) => {
  return new Promise(async (resolve, reject) => {
    try {
      const user = await User.aggregate([
        { $match: { _id: new ObjectId(userId) } },
        { $unwind: '$story' },
    
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$story.createdAt' }
            },
            story: { $push: '$story' }
          }
        },
        {
          $project: {
            _id: 0,
            date: '$_id',
            story: 1
          }
        },
        
        // Sort by date if needed
        { $sort: { date: -1 } }

        
      ]);
      resolve(user);
    } catch (error) {
      reject(error);
    }
  });
};

const updatePostHelper = async (postId, data, _id) => {
  try {
    const hashTags = data.hashTag.match(/#[\w]+/g) || [];
    // Find the existing post by ID
    const existingPost = await Posts.findById(postId);
    if (existingPost.author._id !== _id) {
      return { error: 'You are not the author of this post' };
    }
    if (!existingPost) {
      throw new Error('Post not found');
    }

    // Update the post fields except for imageUrl
    existingPost.content = data.content || existingPost.content;
    existingPost.hashTags = hashTags.length > 0 ? hashTags : existingPost.hashTags;
    existingPost.title = data.title || existingPost.title;
    existingPost.body = data.body || existingPost.body;
    existingPost.likes = data.likes || existingPost.likes;
    existingPost.comments = data.comments || existingPost.comments;

    // Save the updated post to the database
    const updatedPost = await existingPost.save();
    return updatedPost;
  } catch (error) {
    console.error(error);
    throw new Error(error.message);
  }
};

export {
  userLoginHelper,
  logoutHelper,
  userSignUpHelper,
  userGoogleLoginHelper,
  googleLoginUser,
  userValidateEmailHelper,
  findSuggestion,
  followingHelper,
  profileHelper,
  unFollowingHelper,
  searchHelper,
  userProfileHelper,
  uploadProfileHelper,
  createPostHelper,
  createStoryHelper,
  fetchPostHelper,
  unLikePostHelper,
  likePostHelper,
  userCreateComment,
  fetchPostsHelper,
  deletePostHelper,
  getFollowersHelper,
  getFollowingsHelper,
  deleteCommentHelper,
  getFreshStoriesHelper,
  incrementViewerCountHelper,
  fetchProfileStoresHelper,
  updatePostHelper,
};
