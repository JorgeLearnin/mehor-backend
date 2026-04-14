'use strict';

const { v2: cloudinary } = require('cloudinary');

function ensureCloudinaryConfigured() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    return false;
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });

  return true;
}

async function deleteAvatarByUserId({ userId }) {
  if (!ensureCloudinaryConfigured()) {
    const err = new Error('CLOUDINARY_NOT_CONFIGURED');
    err.status = 500;
    throw err;
  }

  const publicId = `mehor/avatars/${userId}`;
  const res = await cloudinary.uploader.destroy(publicId, {
    resource_type: 'image',
    invalidate: true,
  });

  return { result: res?.result };
}

function uploadRawBufferToCloudinary({ buffer, folder, publicId }) {
  return new Promise((resolve, reject) => {
    const normalizedFolder = typeof folder === 'string' ? folder.trim() : '';
    const opts = {
      public_id: publicId,
      overwrite: true,
      resource_type: 'raw',
      access_mode: 'public',
    };
    if (normalizedFolder) opts.folder = normalizedFolder;

    const stream = cloudinary.uploader.upload_stream(opts, (err, result) => {
      if (err) return reject(err);
      return resolve(result);
    });

    stream.end(buffer);
  });
}

function createSignedRawUploadParams({ folder, publicId }) {
  return createSignedUploadParams({
    folder,
    publicId,
    resourceType: 'raw',
    extraFields: {
      access_mode: 'public',
    },
  });
}

function createSignedUploadParams({
  folder,
  publicId,
  resourceType,
  extraFields,
}) {
  if (!ensureCloudinaryConfigured()) {
    const err = new Error('CLOUDINARY_NOT_CONFIGURED');
    err.status = 500;
    throw err;
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const nowSeconds = Math.floor(Date.now() / 1000);

  const normalizedFolder = typeof folder === 'string' ? folder.trim() : '';

  const paramsToSign = {
    public_id: publicId,
    overwrite: 'true',
    timestamp: nowSeconds,
    ...(extraFields && typeof extraFields === 'object' ? extraFields : {}),
  };

  if (normalizedFolder) paramsToSign.folder = normalizedFolder;

  const signature = cloudinary.utils.api_sign_request(
    paramsToSign,
    process.env.CLOUDINARY_API_SECRET,
  );

  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`,
    fields: {
      api_key: apiKey,
      timestamp: nowSeconds,
      signature,
      public_id: publicId,
      overwrite: 'true',
      ...(extraFields && typeof extraFields === 'object' ? extraFields : {}),
      ...(normalizedFolder ? { folder: normalizedFolder } : {}),
    },
  };
}

function createSignedImageUploadParams({ folder, publicId }) {
  return createSignedUploadParams({
    folder,
    publicId,
    resourceType: 'image',
  });
}

function createSignedRawDownloadUrl({ publicId, format, expiresAt }) {
  if (!ensureCloudinaryConfigured()) {
    const err = new Error('CLOUDINARY_NOT_CONFIGURED');
    err.status = 500;
    throw err;
  }

  const id = String(publicId || '').trim();
  const ext = String(format || '')
    .trim()
    .toLowerCase();
  if (!id || !ext) {
    const err = new Error('publicId and format are required');
    err.status = 400;
    throw err;
  }

  return cloudinary.utils.private_download_url(id, ext, {
    resource_type: 'raw',
    type: 'upload',
    attachment: true,
    expires_at:
      Number.isFinite(Number(expiresAt)) && Number(expiresAt) > 0
        ? Math.floor(Number(expiresAt))
        : Math.floor(Date.now() / 1000) + 300,
  });
}

async function renameRawResource({ fromPublicId, toPublicId }) {
  if (!ensureCloudinaryConfigured()) {
    const err = new Error('CLOUDINARY_NOT_CONFIGURED');
    err.status = 500;
    throw err;
  }

  const fromId = String(fromPublicId || '').trim();
  const toId = String(toPublicId || '').trim();
  if (!fromId || !toId) {
    const err = new Error('fromPublicId and toPublicId are required');
    err.status = 400;
    throw err;
  }

  const res = await cloudinary.uploader.rename(fromId, toId, {
    resource_type: 'raw',
    overwrite: true,
    invalidate: true,
  });

  return {
    url: res.secure_url || res.url,
    publicId: res.public_id,
  };
}

async function deleteRawResourceByPublicId({ publicId }) {
  if (!ensureCloudinaryConfigured()) {
    const err = new Error('CLOUDINARY_NOT_CONFIGURED');
    err.status = 500;
    throw err;
  }

  const id = String(publicId || '').trim();
  if (!id) return { result: 'skipped' };

  const res = await cloudinary.uploader.destroy(id, {
    resource_type: 'raw',
    invalidate: true,
  });

  return { result: res?.result };
}

async function uploadOrderDeliveryZipBuffer({ orderId, buffer }) {
  if (!ensureCloudinaryConfigured()) {
    const err = new Error('CLOUDINARY_NOT_CONFIGURED');
    err.status = 500;
    throw err;
  }

  const publicId = `mehor/orders/${orderId}/delivery_zip`;

  const res = await uploadRawBufferToCloudinary({
    buffer,
    publicId,
  });

  return {
    url: res.secure_url || res.url,
    publicId: res.public_id,
  };
}

function deleteResourcesByPrefix({ prefix, resourceType = 'image' }) {
  return new Promise((resolve, reject) => {
    cloudinary.api.delete_resources_by_prefix(
      prefix,
      { resource_type: resourceType },
      (err, result) => {
        if (err) return reject(err);
        return resolve(result);
      },
    );
  });
}

async function deleteCloudinaryResourcesByPrefix({ prefix, resourceType }) {
  if (!ensureCloudinaryConfigured()) {
    const err = new Error('CLOUDINARY_NOT_CONFIGURED');
    err.status = 500;
    throw err;
  }

  const normalized = String(prefix || '').trim();
  if (!normalized) return { ok: true };

  await deleteResourcesByPrefix({
    prefix: normalized,
    resourceType: resourceType || 'image',
  });

  return { ok: true };
}

async function deleteListingScreenshotByPublicId({ publicId }) {
  if (!ensureCloudinaryConfigured()) {
    const err = new Error('CLOUDINARY_NOT_CONFIGURED');
    err.status = 500;
    throw err;
  }

  const res = await cloudinary.uploader.destroy(publicId, {
    resource_type: 'image',
    invalidate: true,
  });

  return { result: res?.result };
}

module.exports = {
  deleteAvatarByUserId,
  deleteListingScreenshotByPublicId,
  uploadOrderDeliveryZipBuffer,
  createSignedImageUploadParams,
  createSignedRawUploadParams,
  createSignedRawDownloadUrl,
  renameRawResource,
  deleteRawResourceByPublicId,
  deleteCloudinaryResourcesByPrefix,
};
