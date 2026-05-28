const express = require('express');
const multer = require('multer');

const requireAuth = require('./../middleware/requireAuth');
const {
  uploadAvatar,
  uploadListingImage,
  uploadMessageImage,
} = require('./../controllers/upload.controller');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }

    return cb(null, true);
  },
});

router.post('/avatar', requireAuth, upload.single('image'), uploadAvatar);

router.post(
  '/listing-image',
  requireAuth,
  upload.single('image'),
  uploadListingImage,
);

router.post(
  '/message-image',
  requireAuth,
  upload.single('image'),
  uploadMessageImage,
);

module.exports = router;
