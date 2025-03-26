const fs = require('fs');
const https = require('https');
const { promisify } = require('util');
const { exec } = require('child_process');
const path = require('path');

// Convert exec to promise-based
const execPromise = promisify(exec);

// Configuration
const API_BASE_URL = 'https://api.thequestlabs.com';
const TASK_GET_ENDPOINT = '/api/v1/worker_task_get/previewSpriteImg';
const SIGN_S3_ENDPOINT = '/api/workerSignS3';
const TASK_UPDATE_ENDPOINT = '/api/v1/worker_task_set';

/**
 * Make HTTP request and return parsed JSON
 * @param {string} url - The URL to request
 * @param {Object} options - Request options
 * @param {any} data - Request body (for POST/PUT)
 * @returns {Promise<Object>} Response data
 */
function httpRequest(url, options = {}, data = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        try {
          const parsedData = JSON.parse(responseData);
          resolve(parsedData);
        } catch (error) {
          reject(new Error(`Error parsing response: ${error.message}`));
        }
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    if (data) {
      if (typeof data === 'object') {
        req.write(JSON.stringify(data));
      } else {
        req.write(data);
      }
    }
    
    req.end();
  });
}

/**
 * Fetch task from API
 * @returns {Promise<Object>} Task data
 */
async function fetchTask() {
  try {
    const url = new URL(`${API_BASE_URL}${TASK_GET_ENDPOINT}`);
    return await httpRequest(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Error fetching task:', error.message);
    throw error;
  }
}

/**
 * Download file from URL to local path
 * @param {string} url URL of the file to download
 * @param {string} outputPath Local path to save the file
 * @returns {Promise<void>}
 */
function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);
    
    https.get(url, (response) => {
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (error) => {
      fs.unlink(outputPath, () => {}); // Clean up partial file
      reject(error);
    });
  });
}

/**
 * Generate sprite image preview using shell script
 * @param {string} inputFile Path to input video file
 * @param {string} outputFile Path where output webp will be saved
 * @returns {Promise<void>}
 */
async function generateSpriteImage(inputFile, outputFile) {
  try {
    const { stdout, stderr } = await execPromise(`./previewSpriteImg.sh ${inputFile}`);
    if (stderr) {
      console.warn('Script warnings:', stderr);
    }
    console.log('Script output:', stdout);
    return true;
  } catch (error) {
    console.error('Error generating sprite image:', error.message);
    throw error;
  }
}

/**
 * Get signed S3 URL for file upload
 * @param {string} filename Name of the file to upload
 * @returns {Promise<Object>} Signed URL data
 */
async function getSignedS3Url(filename) {
  try {
    const url = new URL(`${API_BASE_URL}${SIGN_S3_ENDPOINT}`);
    url.searchParams.append('filename', filename);
    
    return await httpRequest(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Error getting signed S3 URL:', error.message);
    throw error;
  }
}

/**
 * Upload file to S3 using signed URL
 * @param {string} signedUrl URL to upload to
 * @param {string} filePath Local path of file to upload
 * @returns {Promise<void>}
 */
async function uploadFileToS3(signedUrl, filePath) {
  return new Promise((resolve, reject) => {
    const fileContent = fs.readFileSync(filePath);
    const parsedUrl = new URL(signedUrl);
    
    const options = {
      method: 'PUT',
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'Content-Type': 'image/webp',
        'Content-Length': fileContent.length
      }
    };
    
    const req = https.request(options, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log('File uploaded successfully');
        resolve();
      } else {
        reject(new Error(`Upload failed with status code: ${res.statusCode}`));
      }
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    req.write(fileContent);
    req.end();
  });
}

/**
 * Update task with result
 * @param {string} taskId ID of the task to update
 * @param {string} resultUrl Public URL of the processed file
 * @returns {Promise<Object>} Update response
 */
async function updateTaskResult(params) {
  try {
    const data = params;
    
    return await httpRequest(`${API_BASE_URL}${TASK_UPDATE_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(data))
      }
    }, data);
  } catch (error) {
    console.error('Error updating task result:', error.message);
    throw error;
  }
}

/**
 * Process a previewSpriteImg task
 * @param {Object} task Task data
 */
async function processPreviewSpriteImgTask(task) {
  const mediaUrl = task.data.params.mediaUrl;
  const taskId = task.data._id;
  
  // Extract filename and extension from URL
  const urlPath = new URL(mediaUrl).pathname;
  const fileExtension = path.extname(urlPath) || '.mp4'; // Default to .mp4 if no extension
  const inputFile = `input${fileExtension}`;
  const outputFile = 'out.webp';
  const thumbFile = 'thumb.webp';
  const infoFile = 'video_info.json';


  try {
    // Download video file
    console.log(`Downloading video from ${mediaUrl}`);
    await downloadFile(mediaUrl, inputFile);
    
    // Generate sprite image
    console.log('Generating sprite image preview');
    await generateSpriteImage(inputFile, outputFile);
    
    // Get signed URL for upload
    console.log('Getting signed S3 URL');
    const s3Data = await getSignedS3Url(outputFile);
    
    if (s3Data.code !== 0) {
      throw new Error(`Failed to get signed URL: ${s3Data.info}`);
    }
    
    // Upload file to S3
    console.log(`Uploading to ${s3Data.data.url}`);
    await uploadFileToS3(s3Data.data.url, outputFile);

    // Get signed URL for upload
    console.log('Getting signed S3 URL');
    const s3Thumb = await getSignedS3Url(thumbFile);
    
    if (s3Thumb.code !== 0) {
      throw new Error(`Failed to get signed URL: ${s3Thumb.info}`);
    }
    
    // Upload file to S3
    console.log(`Uploading to ${s3Thumb.data.url}`);
    await uploadFileToS3(s3Thumb.data.url, thumbFile);


    let result = {};
      try {
          const infoData = fs.readFileSync(infoFile, 'utf8');
          result = JSON.parse(infoData);
          console.log('JSON 内容:', infoData);
      } catch (err) {
          console.error('读取或解析 JSON 失败:', err);
      }
    // Update task with result
    result.spriteUrl = s3Data.data.pubUrl;
    result.thumbUrl = s3Thumb.data.pubUrl;
    console.log('Updating task with result', result);
    const updateResult = await updateTaskResult({task_id:taskId, state:3, result:result});
    
    console.log('Task completed successfully:', updateResult);
    // Clean up
    fs.unlinkSync(inputFile);
    fs.unlinkSync(outputFile);
    
  } catch (error) {
    console.error('Error processing task:', error);
  }
}

/**
 * Main function to run the worker
 */
async function main() {
  for(;;){
  try {
    // Fetch task
    console.log('Fetching task...');
    const taskResponse = await fetchTask();
    
    // Check if task fetch was successful
    if (taskResponse.code !== 0) {
      console.error(`Task fetch failed: ${taskResponse.info}`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
    }
    
    console.log(`Task received: ${taskResponse.data}`);
    
    // Process task based on name
    if (taskResponse.data.name === 'previewSpriteImg') {
      await processPreviewSpriteImgTask(taskResponse);
    } else {
      console.log(`Unknown task type: ${taskResponse.data.name}`);
    }
  } catch (error) {
    console.error('Worker process failed:', error);
  }
  }
}

// Run the worker
main();
