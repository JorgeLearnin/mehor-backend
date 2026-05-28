const cloudinary = require('../lib/cloudinary');

const uploadAvatar = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Image file is required' });
    }

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: 'mehor/users/avatars',
          resource_type: 'image',
        },
        (error, uploadResult) => {
          if (error) reject(error);
          else resolve(uploadResult);
        },
      );

      stream.end(req.file.buffer);
    });

    return res.status(201).json({
      success: true,
      url: result.secure_url,
      publicId: result.public_id,
    });
  } catch (err) {
    console.error('Upload avatar error:', err);
    return res.status(500).json({ error: 'Failed to upload avatar' });
  }
};

const uploadListingImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Image file is required' });
    }

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: 'mehor/listings/images',
          resource_type: 'image',
        },
        (error, uploadResult) => {
          if (error) reject(error);
          else resolve(uploadResult);
        },
      );

      stream.end(req.file.buffer);
    });

    return res.status(201).json({
      success: true,
      url: result.secure_url,
      publicId: result.public_id,
    });
  } catch (err) {
    console.error('Upload listing image error:', err);
    return res.status(500).json({ error: 'Failed to upload image' });
  }
};

const uploadMessageImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Image file is required' });
    }

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: 'mehor/messages/images',
          resource_type: 'image',
        },
        (error, uploadResult) => {
          if (error) reject(error);
          else resolve(uploadResult);
        },
      );

      stream.end(req.file.buffer);
    });

    return res.status(201).json({
      success: true,
      url: result.secure_url,
      publicId: result.public_id,
      fileName: req.file.originalname || null,
      mimeType: req.file.mimetype || null,
      sizeBytes: req.file.size || null,
    });
  } catch (err) {
    console.error('Upload message image error:', err);
    return res.status(500).json({ error: 'Failed to upload message image' });
  }
};

module.exports = {
  uploadAvatar,
  uploadListingImage,
  uploadMessageImage,
};
