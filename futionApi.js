#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { spawnSync } = require('child_process');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const axios = require('axios');

global.task = {};
global.currentSwapIndex = 0;  // 当前换脸组数
global.totalSwapCount = 0;    // 总换脸组数
global.hasEnhancement = false; // 是否有强化
global.totalSteps = 0;        // 总步骤数

let lastLog = "";

const API_BASE_URL = 'https://api.fakeface.io/api';
const MODEL_MAP = {
  1: "inswapper_128",
  2: "blendswap_256",
  3: "inswapper_128_fp16",
  4: "simswap_256",
  5: "simswap_512_unofficial"
};
var lastDataTime = Date.now();

function runCmdFast(cmd){
   execSync(cmd, { stdio: 'inherit' });
}
function runCmd(cmd, args){
    // 只输出命令本身，不输出详细参数
    console.log(`执行命令: ${cmd}`);
    const ffmpegProcess = spawn(cmd, args);
    
    // 超时检测变量
    let lastDataTime = Date.now();
    const timeoutDuration = 5 * 60 * 1000; // 5分钟超时
    let timeoutTimer;
    
    // 进度更新控制变量
    let lastUpdateTime = 0;
    const updateInterval = 5000; // 5秒更新一次

    let lastSendTime = 0;

    // 设置超时检测定时器
    const setupTimeoutCheck = () => {
        clearTimeout(timeoutTimer);
        timeoutTimer = setTimeout(() => {
            const currentTime = Date.now();
            if (currentTime - lastDataTime > timeoutDuration) {
                if(lastLog.indexOf('Processing') >= 0 || lastLog.indexOf('Downloading') >= 0){
                    console.error('执行超时（5分钟无数据）：强制终止进程' + lastLog);
                    ffmpegProcess.kill('SIGKILL'); // 强制终止进程
                }else{
                    console.error('5分钟无数据,继续等待,最后一次日志:' + lastLog);
                }
            } else {
                setupTimeoutCheck(); // 重新设置检查
            }
        }, 30000); // 每30秒检查一次
    };

    setupTimeoutCheck();
    
    return new Promise((resolve, reject) => {
        // stdout数据处理 - 不再输出详细日志
        ffmpegProcess.stdout.on('data', (data) => {
            // 更新最后收到数据的时间
            lastDataTime = Date.now();
        });

        // stderr数据处理 - 带有进度更新的限制
        ffmpegProcess.stderr.on('data', async (data) => {

            lastDataTime = Date.now();
            const lines = data.toString().split('\n');
            if(lines.length <= 0)return;
            let line = lines[0];
            lastLog = lines[lines.length - 1].trim();
            if(lastLog.length <= 0 && lines.length > 1){
              lastLog = lines[lines.length - 2].trim();
            }
           
            // 更新最后收到数据的时间
            const currentTime = Date.now();
            lastUpdateTime = currentTime;

            //更新不要太频繁
            if(currentTime - lastSendTime < updateInterval){
                return;
            }
           
            const match = line.match(/\[([^\]]+)\] Processing:\s+(\d+%)\|.*\|\s+(\d+\/\d+).*?([\d.]+)frame\/s/);
            if (!match) {return};
            
            // 计算真实进度
            const currentStepProgress = parseInt(match[2].replace('%', ''));
            let realProgress = 0;
            
            if (global.totalSteps > 0) {
                // 计算当前步骤在整体中的位置
                const currentStepIndex = global.currentSwapIndex; // 从0开始
                const baseProgress = Math.floor((currentStepIndex / global.totalSteps) * 100);
                const stepProgressContribution = Math.floor((currentStepProgress / global.totalSteps));
                realProgress = Math.min(99, baseProgress + stepProgressContribution);
            } else {
                realProgress = currentStepProgress;
            }
             
            const json = {
                   module: match[1],              // "FACE_SWAPPER"
                   progress: realProgress,  // 使用计算后的真实进度
                   frameCount: match[3],          // "10/570"
                   fps: parseFloat(match[4])      // 23.32
             };
             try {
                 const data = await ApiClient.callApi("v1/worker_task_process/" + global.task._id, json);
                 console.log(`Progress: ${match[1]} ${realProgress}% (Step ${global.currentSwapIndex + 1}/${global.totalSteps}) ${match[3]} fps:${json.fps} \r`);
             } catch (error) {
                 console.error(`进度更新失败: ${error.message}`);
             }
             lastSendTime = currentTime;
        });

        // 进程结束回调
        ffmpegProcess.on('close', (code) => {
            // 清除超时检测定时器
            clearTimeout(timeoutTimer);
            
            if (Date.now() - lastDataTime > timeoutDuration) {
                console.log(`进程因超时被终止`);
                resolve(-9);
            } else {
                console.log(`进程正常退出，退出码 ${code}`);
                resolve(code);
            }
        });

        // 进程错误处理
        ffmpegProcess.on('error', (error) => {
            clearTimeout(timeoutTimer);
            console.error(`进程错误: ${error.message}`);
            resolve(-1);
        });
    });
}

// 工具类
class Utils {

  static isAnimatedWebP(filePath) {
      const buffer = fs.readFileSync(filePath);
      return buffer.includes(Buffer.from('ANIM'));
  }
  /**
   * 计算字符串的MD5哈希值
   * @param {string} inputString 
   * @returns {string} MD5哈希
   */
  static calculateMd5(inputString) {
    return crypto.createHash('md5').update(inputString).digest('hex');
  }

  static saveBase64Image(base64String, outputPath) {
    const matches = base64String.match(/^data:(.+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      throw new Error('无效的 base64 图片字符串');
    }

    const mimeType = matches[1];     // 例如 image/png
    const extension = mimeType.split('/')[1]; // png
    const imageData = matches[2];    // base64 数据

    // 自动补全扩展名
    const fullPath = outputPath.endsWith(`.${extension}`)
      ? outputPath
      : `${outputPath}.${extension}`;

    fs.writeFileSync(fullPath, Buffer.from(imageData, 'base64'));
    console.log(`图片已保存为：${fullPath}`);
  }

  /**
   * 删除文件列表
   * @param {string[]} filePaths 
   */
  static deleteFiles(filePaths) {
    for (const filePath of filePaths) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`File '${filePath}' has been deleted.`);
      } else {
        console.log(`File '${filePath}' does not exist, no need to delete.`);
      }
    }
  }

  /**
   * 从URL下载文件
   * @param {string} fileUrl 
   * @param {string} outputPath 
   * @returns {Promise<void>}
   */
  static async downloadFile(fileUrl, outputPath) {
    const writer = fs.createWriteStream(outputPath);
    
    try {
      const response = await axios({
        url: fileUrl,
        method: 'GET',
        responseType: 'stream'
      });
      
      response.data.pipe(writer);
      
      return new Promise((resolve, reject) => {
        writer.on('finish', () => {
          console.log(`File '${outputPath}' downloaded and saved successfully.`);
          resolve();
        });
        writer.on('error', reject);
      });
    } catch (error) {
      writer.close();
      console.error(`Error downloading file from ${fileUrl}: ${error.message}`);
      throw error;
    }
  }

  /**
   * 上传文件到已签名的S3 URL
   * @param {string} filePath 
   * @param {string} signedUrl 
   * @returns {Promise<boolean>}
   */
  static async uploadFileToS3(filePath, signedUrl, maxRetries = 3) {
  const TIMEOUT_MS = 60 * 60 * 1000; // 60分钟超时
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`开始第 ${attempt} 次上传尝试...`);
      
      const fileContent = fs.readFileSync(filePath);
      const fileSize = fs.statSync(filePath).size;
      
      const parsedUrl = new URL(signedUrl);
      
      console.log(`正在上传 ${filePath} (${fileSize} bytes)...`);
      
      const config = {
        method: 'PUT',
        url: signedUrl,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': fileSize
        },
        data: fileContent,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: TIMEOUT_MS, // 设置20分钟超时
        validateStatus: (status) => {
          return status >= 200 && status < 300; // 只有2xx状态码才算成功
        }
      };
      
      const response = await axios(config);
      
      if (response.status === 200 || response.status === 204) {
        console.log(`第 ${attempt} 次上传成功`);
        return true;
      } else {
        throw new Error(`上传失败，状态码: ${response.status} ${response.statusText}`);
      }
      
    } catch (error) {
      console.error(`第 ${attempt} 次上传失败:`, error.message);
      
      // 如果是最后一次尝试，返回 false
      if (attempt === maxRetries) {
        console.error(`上传最终失败，已尝试 ${maxRetries} 次。最后错误: ${error.message}`);
        return false;
      }
      
      // 等待一段时间后重试（递增延迟策略）
      const delay = attempt * 2000; // 2秒，4秒，6秒...
      console.log(`等待 ${delay / 1000} 秒后重试...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  return false; // 理论上不会到达这里，但为了安全起见
}

}

  class ApiClient {
  /**
   * 调用API
   * @param {string} name API端点名称
   * @param {object} data 请求数据
   * @returns {Promise<object>} 响应数据
   */
  static async callApi(name, data = {}) {
    try {
      let url = '';
      let method = 'POST';
      
      url = `${API_BASE_URL}/${name}`;

      const config = {
        method,
        url,
        timeout: 10000
      };
      
      if (method === 'POST') {
        config.data = data;
      }
      
      const response = await axios(config);
      
      if (response.status === 200) {
    //    console.log('Request successful', name, response.data);
        return response.data;
      } else {
        console.log('Request failed', name);
        console.log(response.data?.message || 'Unknown error');
        return { code: -1, info: response.data?.message || 'Unknown error' };
      }
    } catch (error) {
      console.error('Error:', error.message);
      return { code: -1, info: error.message };
    }
  }

  /**
   * 更新任务状态
   * @param {object} taskData 任务数据
   * @param {boolean} finish 是否完成
   * @param {number} state 状态码
   * @param {string} log 日志
   * @param {number} process 进度
   * @param {number} totalFrame 总帧数
   */
  static async addLog(taskData, finish, state, log, process, totalFrame = 0) {
    await this.callApi("v1/worker_task_set", {
       'result': taskData,
      'task_id': taskData._id || '',
      'total_frame': totalFrame,
      'finish': finish ? 1 : 0,
      'state': state,
      'log': log,
      'process': process
    });
  }

  /**
   * 上传文件并获取公开URL
   * @param {string} filePath 
   * @returns {Promise<string|boolean>} 公开URL或失败标志
   */
  static async uploadFile(filePath) {
    console.log("获取上传地址:", filePath);
    const res = await this.callApi("mediaPro/workerSignS3/" + path.extname(filePath).substr(1), { 'filename': filePath });
    console.log("获取上传地址res:", res);
    
    if (res.code < 0) {
      console.log('sign s3url error');
      return false;
    }
    
    const upres = await Utils.uploadFileToS3(filePath, res.data.url);
    if (upres) {
      return res.data.pubUrl;
    }
    return false;
  }
}

// 媒体处理类
class MediaProcessor {
  /**
   * 转换视频分辨率
   * @param {string} inputPath 
   * @param {number} resolution 
   * @param {string} watermarkText 
   * @param {number} startTime 
   * @param {number} endTime 
   */
  static async convertToResolution(inputPath, resolution, watermarkText, startTime = 0, endTime = 0) {

    console.log('resolution:', resolution);
    // 分辨率映射
    const resolutionMap = {
      0:720,
      1: 480,  // 480p
      2: 720,  // 720p
      3: 1080, // 1080p
      4: 1440, // 2k
      5: 2160,  // 4k
      5: 4320  // 4k
    };
    const targetHeight = resolutionMap[resolution] || 720;  // 默认720p
    
    // 创建备份文件名
    const fileName = path.basename(inputPath);
    const fileExt = path.extname(fileName);
    const baseName = path.basename(fileName, fileExt);
    const renamedPath = path.join(path.dirname(inputPath), `src_${baseName}${fileExt}`);
    
    // 备份原始文件
    fs.copyFileSync(inputPath, renamedPath);
            
       // 构建 FFmpeg 命令
    let ffmpegCommand = ['-y', '-i', renamedPath];

    // 获取视频信息（分辨率、帧率）
    const ffprobeOutput = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate -of csv=p=0 ${renamedPath}`).toString().trim();
    const [width, height, frameRate] = ffprobeOutput.split(',');

    // 判断是否需要按帧裁剪
    let applyFrameCut = endTime > startTime;

    let drawTextFilter;
    if (resolution > 0) {
      drawTextFilter = `scale=trunc(iw*${targetHeight}/ih/2)*2:${targetHeight},` +
                       `drawtext=text='${watermarkText}':` +
                       `x=w-tw-20:y=h-th-20:fontsize=h*0.03:` +
                       `fontcolor=white@0.3:shadowx=2:shadowy=2:shadowcolor=black@0.3`;
    } else {
      drawTextFilter = `drawtext=text='${watermarkText}':` +
                       `x=w-tw-20:y=h-th-20:fontsize=h*0.03:` +
                       `fontcolor=white@0.3:shadowx=2:shadowy=2:shadowcolor=black@0.3`;
    }

    // 是否加上帧裁剪的 select 过滤器
    if (endTime > startTime) {
      ffmpegCommand.push('-ss', startTime.toString());
      ffmpegCommand.push('-to', endTime.toString());
    }

    ffmpegCommand.push('-vf', drawTextFilter); // 只加水印，不裁剪

    ffmpegCommand.push('-r', '24');

    // 设置输出路径
    ffmpegCommand.push('media.mp4'); 
            
    // 执行FFmpeg命令
    console.log("FFmpeg Command: ", ffmpegCommand.join(' '));
    await runCmd('ffmpeg', ffmpegCommand);
    console.log(`Video successfully converted and saved as: media.mp4`);
  }

  /**
   * 为MP4添加水印
   * @param {string} inputPath 
   * @param {string} watermarkText 
   */
  static addWatermarkToMp4(inputPath, watermarkText) {
    // 创建备份文件名
    const fileName = path.basename(inputPath);
    const fileExt = path.extname(fileName);
    const baseName = path.basename(fileName, fileExt);
    const renamedPath = path.join(path.dirname(inputPath), `src1_${baseName}${fileExt}`);
    
    // 备份原始文件
    fs.copyFileSync(inputPath, renamedPath);
    
    // 构建FFmpeg命令
    const drawTextFilter = `drawtext=text='${watermarkText}':` +
                          `x=w-tw-20:y=h-th-20:fontsize=h*0.03:` +
                          `fontcolor=white@0.3:shadowx=2:shadowy=2:shadowcolor=black@0.3`;
    
    const ffmpegCommand = [
      'ffmpeg', '-y', '-i', renamedPath,
      '-vf', drawTextFilter,
      'media.mp4'
    ];
    
    // 执行FFmpeg命令
    console.log("FFmpeg Command: ", ffmpegCommand.join(' '));
    runCmdFast(ffmpegCommand.join(' '));
    console.log(`Added watermark to: media.mp4`);
  }

  /**
   * 为图像添加水印
   * @param {string} inputPath 
   * @param {string} outputPath 
   * @param {string} watermarkText 
   */
  static addWatermarkToImage(inputPath, outputPath, watermarkText) {

    // 构建FFmpeg命令
    const ffmpegCommand = [
      'ffmpeg', '-y', '-i', inputPath,
      '-vf',
      `drawtext=text='${watermarkText}':` +
      `x=w-tw-20:y=h-th-20:fontsize=24:` +
      `fontcolor=white@0.3:shadowx=2:shadowy=2:shadowcolor=black@0.3`,
      outputPath
    ];
    
    // 执行命令
    try {
      runCmdFast(ffmpegCommand.join(' '));
      console.log(`Image watermarked and saved as: ${outputPath}`);
    } catch (e) {
      console.error(`Failed to add watermark: ${e.message}`);
    }
  }

  /**
   * 生成图像缩略图
   * @param {string} imagePath 
   * @param {string} thumbnailPath 
   * @param {number} maxSize 
   */
  static generateImgThumbnail(imagePath, thumbnailPath, maxSize = 512) {
    const ffmpegCommand = [
      'ffmpeg', '-y', '-i', imagePath,
      '-vf', `"scale='min(${maxSize},iw)':-1"`,
      thumbnailPath
    ];
    
    runCmdFast(ffmpegCommand.join(' '));
    console.log(`Thumbnail created at: ${thumbnailPath}`);
  }

  /**
   * 生成视频缩略图
   * @param {string} videoPath 
   * @param {string} thumbnailPath 
   * @param {number} maxSize 
   */
  static generateVideoThumbnail(videoPath, thumbnailPath, maxSize = 512) {
    const ffmpegCommand = [
      'ffmpeg', '-y', '-i', videoPath,
      '-vframes', '1',
      '-vf', `"scale='min(${maxSize},iw)':-1"`,
      thumbnailPath
    ];
    
    runCmdFast(ffmpegCommand.join(' '));
    console.log(`Video thumbnail created at: ${thumbnailPath}`);
  }

  /**
   * GIF转MP4
   * @param {string} gifPath 
   * @param {string} mp4Path 
   */
  static gif2mp4(gifPath, mp4Path) {
    const ffmpegCommand = [
      'ffmpeg',
      '-i', gifPath,
      '-vf', '"scale=trunc(iw/2)*2:trunc(ih/2)*2"',
      '-movflags', 'faststart',
      '-pix_fmt', 'yuv420p',
      '-y',
      mp4Path
    ];
    
    runCmdFast(ffmpegCommand.join(' '));
    console.log(`Converted GIF to MP4: ${mp4Path}`);
  }

  /**
   * MP4转GIF
   * @param {string} inputMp4Filename 
   * @param {string} outputGifFilename 
   */
  static mp42gif(inputMp4Filename, outputGifFilename) {
    const paletteFile = 'palette.png';
    
    // 生成调色板
    const ffmpegPaletteCommand = [
      'ffmpeg',
      '-y',
      '-i', inputMp4Filename,
      '-vf', '"fps=15,scale=500:-1:flags=lanczos,palettegen"',
      paletteFile
    ];
    
    runCmdFast(ffmpegPaletteCommand.join(' '));
    
    // 生成GIF
    const ffmpegGifCommand = [
      'ffmpeg',
      '-y',
      '-i', inputMp4Filename,
      '-i', paletteFile,
      '-lavfi', '"fps=10 [x]; [x][1:v] paletteuse"',
      outputGifFilename
    ];
    
    runCmdFast(ffmpegGifCommand.join(' '));
    console.log(`Converted MP4 to GIF: ${outputGifFilename}`);
  }

  /**
   * 为图像添加边框
   * @param {string} inputImagePath 
   * @param {string} outputImagePath 
   */
  static addBorder(inputImagePath, outputImagePath) {
    try {
      // 使用ImageMagick添加边框
      const command = `convert "${inputImagePath}" -bordercolor black -border 25% "${outputImagePath}"`;
      runCmdFast(command);
      console.log(`Successfully added border to ${inputImagePath} and saved to ${outputImagePath}`);
    } catch (e) {
      console.error(`An error occurred: ${e.message}`);
      // 如果出错，至少确保有一个输出文件
      fs.copyFileSync(inputImagePath, outputImagePath);
    }
  }

  /**
   * 处理媒体（人脸替换）
   * @param {string} mediaFilename 
   * @param {string} faceFilename 
   * @param {string} outFilePath 
   * @param {boolean} isEnhancement 
   * @param {number} referenceFrame 
   * @param {number} referenceFacePosition 
   */
  static async procMedia(
    mediaFilename, 
    faceFilename, 
    outFilePath, 
    isEnhancement,
    isReference = 0
  ) {
    console.log(mediaFilename, faceFilename, outFilePath);

    // 构建facefusion命令
    const command = [
      'run.py',
      '-s', faceFilename,
      '-t', mediaFilename,
      '-o', './' + outFilePath,
      '--execution-providers', 'cuda',
      '--headless',
      '--face-mask-types', 'occlusion',
      '--execution-thread-count', '32',
      '--execution-queue-count', '2',
      '--video-memory-strategy', 'tolerant',
      '--temp-frame-format', 'jpg',
      '--output-video-fps', '24',
      '--output-video-quality', '70',
      '--output-video-preset', 'ultrafast',
      '--face-detector-score', '0.25'
    ];
    
    // 根据参考帧设置人脸选择器模式
    if (isReference) {
      command.push(
        '--face-selector-mode', 'reference',
        '--reference-frame-number', 0,
        '--reference-face-distance', '0.8',
        '--reference-face-position', 0
      );
    } else {
      command.push(
        '--face-selector-mode', 'many',
        '--face-analyser-order', 'best-worst'
      );
    }
    
    // 添加帧处理器
    command.push('--frame-processors', 'face_swapper');
    
    // 如果需要面部增强
    if (isEnhancement) {
      command.push('face_enhancer');
    }
    
    console.log(command.join(' '));
    
    // 执行命令
    await runCmd('python', command);
  }

 static async procImage(
    mediaFilename, 
    faceFilename, 
    outFilePath, 
    isEnhancement,
    isReference = 0
  ) {
    console.log(mediaFilename, faceFilename, outFilePath);
    
    // 构建facefusion命令
    const command = [
      'run.py',
      '-s', faceFilename,
      '-t', mediaFilename,
      '-o', './' + outFilePath,
      '--execution-providers', 'cuda',
      '--headless',
      '--face-mask-types', 'occlusion'
    ];

    // 根据参考帧设置人脸选择器模式
    if (isReference) {
      command.push(
        '--face-selector-mode', 'reference',
        '--reference-frame-number', 0,
        '--reference-face-distance', '0.8',
        '--reference-face-position', 0
      );
    } else {
      command.push(
        '--face-selector-mode', 'many',
        '--face-analyser-order', 'best-worst'
      );
    }
 
    // 添加帧处理器
    command.push('--frame-processors', 'face_swapper');
    
    // 如果需要面部增强
    if (isEnhancement) {
      command.push('face_enhancer');
    }
    
    console.log(command.join(' '));
    
    // 执行命令
    await runCmd('python', command);
  }
}

// 工作类 - 主逻辑
class Worker {
  constructor() {
    this.taskData = {};
  }

  /**
   * 执行工作
   */
  async work() {
    const mode = process.argv[2] === 'cpu' ? 'cpu' : 'cuda';
    const term = process.argv[3] || 'cuda';
    
    // 获取任务
    const data = await ApiClient.callApi("v1/worker_task_get/faceSwapApi/" + term, {
      'sc': process.argv[4] || '',
      'mode': mode,
      'term': term
    });
    
    console.log('task:', data);
    
    if (data.code !== 0) {
      console.log("Error: Code is not 0.");
      await new Promise(resolve => setTimeout(resolve, 3000));
      return;
    }
    
    try {
      Utils.deleteFiles([
        'nsfw', 'face.png', 'media.gif', 'media.png', 'media.mp4',
        'media_out.gif', 'media_out.mp4', 'media_out.jpg'
      ]);
      console.log("Temporary files have been removed.");
    } catch (e) {
      console.error(`Error deleting files: ${e.message}`);
    }

    global.task = data.data;
    this.taskData = data.data;
    const params = this.taskData.params || {};

    const mediaFileUrl = params.media_url || '';
    const swapList = params.swap_list || [];
    
    if (!mediaFileUrl || !Array.isArray(swapList) || swapList.length === 0) {
      console.log("Missing media URL or swap list");
      await ApiClient.addLog(this.taskData, true, -1, 'Missing media URL or swap list', 99);
      return;
    }
    
    // 计算总步骤数
    const enhance = parseInt(params.enhance || 0);
    global.totalSwapCount = swapList.length;
    global.hasEnhancement = enhance === 1;
    global.totalSteps = swapList.length + (global.hasEnhancement ? 1 : 0);
    global.currentSwapIndex = 0;
    
    console.log(`总共需要 ${global.totalSteps} 个步骤: ${swapList.length} 组换脸${global.hasEnhancement ? ' + 1 次强化' : ''}`);
    
    // 下载媒体文件
    const mediaExt = path.extname(mediaFileUrl);
    const inputFilename = "input" + mediaExt;
    
    await Utils.downloadFile(mediaFileUrl, inputFilename);
    
    // 解析参数
    const mediaType = params.type || 'video'; // video, gif, image
    const resolution = parseInt(params.resolution || 0);
    const needCredit = parseInt(this.taskData.needCredit || 0);  
    const startTime = parseInt(params.start_time || 0);
    const endTime = parseInt(params.end_time || 0);
    const watermarkText = params.watermark || '';
    const nsfwCheck = parseInt(params.nsfw_check || 0);
    
    // NSFW检查
    if (nsfwCheck === 1) {
      fs.writeFileSync("nsfw", "");
    }
    
    // 处理WebP动画
    let processedInputFilename = inputFilename;
    if (mediaExt.toLowerCase() === '.webp' && Utils.isAnimatedWebP(inputFilename)) {
      const command = [
        'convert',
        inputFilename,
        'input.gif',
      ];
      runCmdFast(command.join(' '));
      processedInputFilename = 'input.gif';
    }
    
    // 根据媒体类型进行预处理
    let mediaFilename = '';
    if (mediaType === 'video') {
      mediaFilename = 'media.mp4';
      await MediaProcessor.convertToResolution(processedInputFilename, resolution, watermarkText, startTime, endTime);
    } else if (mediaType === 'gif') {
      mediaFilename = 'media.mp4';
      MediaProcessor.gif2mp4(processedInputFilename, 'temp_media.mp4');
      MediaProcessor.addWatermarkToMp4('temp_media.mp4', watermarkText);
    } else if (mediaType === 'image') {
      mediaFilename = 'media.jpg';
      MediaProcessor.addWatermarkToImage(processedInputFilename, mediaFilename, watermarkText);
    }
    
    // 开始多组人脸替换
    let currentInputFile = mediaFilename;
    
    for (let i = 0; i < swapList.length; i++) {
      const swap = swapList[i];
      const swapIndex = i + 1;
      const isLastSwap = swapIndex === swapList.length;
      const shouldEnhance = isLastSwap && global.hasEnhancement; // 只有最后一组才强化
      
      // 更新当前步骤索引
      global.currentSwapIndex = i;
      
      console.log(`开始第 ${swapIndex}/${swapList.length} 组人脸替换${shouldEnhance ? ' (含强化)' : ''}`);
      
      // 下载源人脸和目标人脸
      const fromFaceFilename = `reface.png`;
      const toFaceFilename = `to_face_${swapIndex}.png`;

      try {
        Utils.deleteFiles([
          fromFaceFilename
        ]);
        console.log("Temporary files have been removed.");
      } catch (e) {
        console.error(`Error deleting files: ${e.message}`);
      }
      
      await Utils.downloadFile(swap.from_face, fromFaceFilename);
      await Utils.downloadFile(swap.to_face, toFaceFilename);
      
      // 为人脸图像添加边框
    //  MediaProcessor.addBorder(fromFaceFilename, fromFaceFilename);
      MediaProcessor.addBorder(toFaceFilename, toFaceFilename);
      
      // 设置输出文件名
      const outputFilename = isLastSwap ? 'media_out' : `media_temp_${swapIndex}`;
      let outputPath = '';
      
      if (mediaType === 'video') {
        outputPath = outputFilename + '.mp4';
        await MediaProcessor.procMedia(
          currentInputFile, 
          toFaceFilename, 
          outputPath, 
          shouldEnhance, 
          swap.from_face?1:0
        );
      } else if (mediaType === 'gif') {
        outputPath = outputFilename + '.mp4';
        await MediaProcessor.procMedia(
          currentInputFile, 
          toFaceFilename, 
          outputPath, 
          shouldEnhance, 
           swap.from_face?1:0
        );
      } else if (mediaType === 'image') {
        outputPath = outputFilename + '.jpg';
        await MediaProcessor.procImage(
          currentInputFile, 
          toFaceFilename, 
          outputPath, 
          shouldEnhance, 
          swap.from_face?1:0
        );
      }
      
      // 更新当前输入文件为这次的输出文件
      if (!isLastSwap) {
        currentInputFile = outputPath;
      }
      
      console.log(`第 ${swapIndex}/${swapList.length} 组人脸替换完成`);
    }
    
    // 处理最终输出
    if (mediaType === 'video') {
      const finalOutputPath = 'media_out.mp4';
      const thumbFilePath = 'thumb_media.jpg';
      MediaProcessor.generateVideoThumbnail(finalOutputPath, thumbFilePath);
      
      if (!fs.existsSync(finalOutputPath)) {
        console.log(`Cannot find file ${finalOutputPath}`);
        await ApiClient.addLog(this.taskData, true, -1, 'Processing failed', 99);
        return;
      }
      
      const uploadVideoUrl = await ApiClient.uploadFile(finalOutputPath);
      const uploadImageUrl = await ApiClient.uploadFile(thumbFilePath);
      console.log('Upload result:', uploadVideoUrl, uploadImageUrl);
      
      const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
      const finishMediaId = params.media_id || '';
     
      let mediaData = {
        'user_id': this.taskData.user_id,
        'media_id': finishMediaId,
        'file_url': uploadVideoUrl,
        'thumb_url': uploadImageUrl,
        'file_hash': now
      };
      console.log('mediaData:', mediaData);
      let apiRes = await ApiClient.callApi("v1/worker_task_set", {state:3, task_id:this.taskData._id, result:mediaData});
      
      console.log('Api result:', apiRes);
      return;
      
    } else if (mediaType === 'gif') {
      const finalOutputPath = 'media_out.gif';
      const thumbFilePath = 'thumb_media.jpg';
      MediaProcessor.generateVideoThumbnail('media_out.mp4', thumbFilePath);
      MediaProcessor.mp42gif('media_out.mp4', finalOutputPath);
      
      if (!fs.existsSync(finalOutputPath)) {
        console.log(`Cannot find file ${finalOutputPath}`);
        await ApiClient.addLog(this.taskData, true, -1, 'Processing failed', 99);
        return;
      }
      
      const uploadVideoUrl = await ApiClient.uploadFile(finalOutputPath);
      const uploadImageUrl = await ApiClient.uploadFile(thumbFilePath);
      console.log('Upload result:', uploadVideoUrl, uploadImageUrl);
      
      const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
      const finishMediaId = params.media_id || '';

      let mediaData = {
        'user_id': this.taskData.user_id,
        'media_id': finishMediaId,
        'file_url': uploadVideoUrl,
        'thumb_url': uploadImageUrl,
        'file_hash': now
      };  
      console.log('mediaData:', mediaData);
      let apiRes = await ApiClient.callApi("v1/worker_task_set", {state:3, task_id:this.taskData._id, result:mediaData});
      return;
      
    } else if (mediaType === 'image') {
      const finalOutputPath = 'media_out.jpg';
      const thumbFilePath = 'thumb_media.jpg';
      MediaProcessor.generateImgThumbnail(finalOutputPath, thumbFilePath);

      if (!fs.existsSync(finalOutputPath)) {
        console.log(`Cannot find file ${finalOutputPath}`);
        await ApiClient.addLog(this.taskData, true, -1, 'Processing failed', 99);
        return;
      }
      
      const uploadFileUrl = await ApiClient.uploadFile(finalOutputPath);
      const uploadImageUrl = await ApiClient.uploadFile(thumbFilePath);
      
      const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
      const finishMediaId = params.media_id || '';
      let mediaData = {
        'user_id': this.taskData.user_id,
        'media_id': finishMediaId,
        'file_url': uploadFileUrl,
        'thumb_url': uploadImageUrl,
        'file_hash': now
      };
      console.log('mediaData:', mediaData);
      let apiRes = await ApiClient.callApi("v1/worker_task_set", {state:3, task_id:this.taskData._id, result:mediaData});
    }
  }
}

// 主程序入口
async function main() {
  const worker = new Worker();
  await worker.work();
}

// 执行主程序
if (require.main === module) {
  main().catch(error => {
    console.error('Error in main program:', error);
    process.exit(1);
  });
}

module.exports = {
  Utils,
  ApiClient,
  MediaProcessor,
  Worker
};
