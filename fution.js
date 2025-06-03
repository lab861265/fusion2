#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync, spawn, spawnSync } from 'child_process';
import https from 'https';
import crypto from 'crypto';
import { URL } from 'url';
import axios from 'axios';
import got from 'got';
import ProgressStream from 'progress-stream';

global.task = {};

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
             const json = {
                   module: match[1],              // "FACE_SWAPPER"
                   progress: match[2],            // "2%"
                   frameCount: match[3],          // "10/570"
                   fps: parseFloat(match[4])      // 23.32
             };
             try {
                 const data = await ApiClient.callApi("v1/worker_task_process/" + global.task._id, json);
                 console.log(`Progress: ${match[1]} ${match[2]}%    ${match[3]}   fps:${json.fps} \r`);
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
static async uploadFileToS3(filePath, signedUrl, contentType = 'application/octet-stream') {

     const maxRetries = 3;
  const timeoutNoProgress = 10 * 60 * 1000; // 10分钟无进度则强制终止
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`🚀 尝试上传 (第 ${attempt} 次)...`);

    try {
      const progress = ProgressStream({ length: fileSize, time: 1000 });
      let lastProgressTime = Date.now();

      progress.on('progress', p => {
        lastProgressTime = Date.now();
        process.stdout.write(`\r📦 上传进度：${Math.round(p.percentage)}%`);
      });

      const timeoutChecker = setInterval(() => {
        if (Date.now() - lastProgressTime > timeoutNoProgress) {
          progress.destroy(new Error('❌ 超过10分钟无进度，强制终止上传'));
        }
      }, 30 * 1000); // 每30秒检查一次是否卡住

      await got(signedUrl, {
        method: 'PUT',
        body: fs.createReadStream(filePath).pipe(progress),
        headers: {
          'Content-Type': contentType,
          'Content-Length': fileSize
        },
        timeout: {
          request: timeoutNoProgress + 60 * 1000 // 预留60秒缓冲
        },
        retry: { limit: 0 } // 不使用 got 自动重试
      });

      clearInterval(timeoutChecker);
      console.log('\n✅ 上传成功');
      return true;

    } catch (err) {
      console.error(`\n⚠️ 上传失败（第 ${attempt} 次）：`, err.message);
      if (attempt === maxRetries) {
      //  throw new Error(`❌ 上传失败：已尝试 ${maxRetries} 次`);
        return false;
      }
      console.log('⏳ 准备重试...\n');
    }
  }
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
   * @param {boolean} needCredit 
   * @param {number} startTime 
   * @param {number} endTime 
   */
  static async convertToResolution(inputPath, resolution, needCredit, startTime = 0, endTime = 0) {

    console.log('resolution:', resolution);
    // 分辨率映射
    const resolutionMap = {
      0:720,
      1: 480,  // 480p
      2: 720,  // 720p
      3: 1080, // 1080p
      4: 1440, // 2k
      5: 2160  // 4k
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
                       `drawtext=text='':` +
                       `x=w-tw-20:y=h-th-20:fontsize=h*0.03:` +
                       `fontcolor=white@0.3:shadowx=2:shadowy=2:shadowcolor=black@0.3`;
    } else {
      drawTextFilter = `drawtext=text='':` +
                       `x=w-tw-20:y=h-th-20:fontsize=h*0.03:` +
                       `fontcolor=white@0.3:shadowx=2:shadowy=2:shadowcolor=black@0.3`;
    }

    // 是否加上帧裁剪的 select 过滤器

    ffmpegCommand.push('-ss', startTime.toString());
    ffmpegCommand.push('-to', endTime.toString());

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
   */
  static addWatermarkToMp4(inputPath) {
    // 创建备份文件名
    const fileName = path.basename(inputPath);
    const fileExt = path.extname(fileName);
    const baseName = path.basename(fileName, fileExt);
    const renamedPath = path.join(path.dirname(inputPath), `src1_${baseName}${fileExt}`);
    
    // 备份原始文件
    fs.copyFileSync(inputPath, renamedPath);
    
    // 构建FFmpeg命令
    const drawTextFilter = `drawtext=text='':` +
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
   */
  static addWatermarkToImage(inputPath, outputPath) {

    // 构建FFmpeg命令
    const ffmpegCommand = [
      'ffmpeg', '-y', '-i', inputPath,
      '-vf',
      `drawtext=text='':` +
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
   * @param {boolean} needCredit 
   * @param {number} resolution 
   * @param {number} modelId 
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
   // runCmd("cp media.mp4 media_out.mp4");
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
    const data = await ApiClient.callApi("v1/worker_task_get/faceSwap/" + term, {
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
    const faceFileUrl = params.face_url || '';
    
    if (!mediaFileUrl || !faceFileUrl) {
      console.log("Missing file URLs");
      await ApiClient.addLog(this.taskData, true, -1, 'Missing file URLs', 99);
      return;
    }
    
    // 下载文件
    var mediaExt = path.extname(mediaFileUrl);
    var faceExt = path.extname(faceFileUrl);
    var inputFilename = "input" + mediaExt;
    var mediaFilename = "media" + mediaExt;
    var faceFilename = "face" + faceExt;
    
    await Utils.downloadFile(mediaFileUrl, inputFilename);
    await Utils.downloadFile(faceFileUrl, faceFilename);
    
    MediaProcessor.addBorder(faceFilename, faceFilename);
    
    var extName = mediaExt.toLowerCase();
    
    // 解析参数
    const isEnhancement = parseInt(params.isEnhancement || 0);
    const resolution = parseInt(params.resolution || 0);  // 默认不变
    const needCredit = parseInt(this.taskData.needCredit || 0);
    

    const startTime = parseInt(params.startTime || 0);
    const endTime = parseInt(params.endTime || 0);
    
  
    if(params.reference_face){
      Utils.saveBase64Image(params.reference_face, './reface');
      MediaProcessor.addBorder('reface.png', 'reface.png');
    }
    //webp2gif
    if(extName == '.webp'){
        if(Utils.isAnimatedWebP(inputFilename)){
           const command = [
               'convert',
                inputFilename,
               'input.gif',
           ];
           runCmdFast(command.join(' '));
           inputFilename = 'input.gif';
           mediaFilename = 'media.gif';
           mediaExt = '.gif';
           extName = '.gif';
        }
    }
    // NSFW检查
    const nsfw = parseInt(params.checkMode || 0);
    if (nsfw === 1) {
      fs.writeFileSync("nsfw", "");
    }
    
    // 处理不同类型的媒体
    const videoExtensions = [
      '.mp4', '.m4v', '.mkv', '.avi', '.mov', '.webm', '.mpeg', '.mpg', 
      '.wmv', '.flv', '.asf', '.3gp', '.3g2', '.ogg', '.vob', '.rmvb', 
      '.ts', '.m2ts', '.divx', '.xvid', '.h264', '.avc', '.hevc', '.vp9', '.avchd'
    ];
    
    if (videoExtensions.includes(extName)) {
        //视频要预处理
      try {
         await MediaProcessor.convertToResolution(inputFilename, resolution, needCredit, startTime, endTime);
    //      runCmd(`ffmpeg -i ${inputFilename} -vf "drawtext=text='My Watermark':fontcolor=white:fontsize=24:x=10:y=10" -c:a copy ${mediaFilename}`);
      } catch (e) {
        console.error(e.message);
      }
    
      const outFilePath = 'media_out.mp4';
      await MediaProcessor.procMedia(
        'media.mp4', faceFilename, outFilePath, isEnhancement, params.reference_face?1:0
      );
      
      const thumbFilePath = 'thumb_media.jpg';
      MediaProcessor.generateVideoThumbnail(outFilePath, thumbFilePath);
      
      if (!fs.existsSync(outFilePath)) {
        console.log(`Cannot find file ${outFilePath}`);
        await ApiClient.addLog(this.taskData, true, -1, 'Processing failed', 99);
        return;
      }
      
      const uploadVideoUrl = await ApiClient.uploadFile(outFilePath);
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
      process.exit(1);
      return;
    } else if (extName === '.gif') {
      // 处理GIF文件
      const outFilePath = 'media_out.mp4';
      MediaProcessor.gif2mp4(inputFilename, 'media.mp4');
      MediaProcessor.addWatermarkToMp4('media.mp4');
      
      await MediaProcessor.procMedia(
        'media.mp4', faceFilename, outFilePath, isEnhancement, params.reference_face?1:0
      );
      
      const thumbFilePath = 'thumb_media.jpg';
      MediaProcessor.generateVideoThumbnail(outFilePath, thumbFilePath);
      MediaProcessor.mp42gif('media_out.mp4', 'media_out.gif');
      
      if (!fs.existsSync('media_out.gif')) {
        console.log("Cannot find file media_out.gif");
        await ApiClient.addLog(this.taskData, true, -1, 'Processing failed', 99);
        return;
      }
      
      const uploadVideoUrl = await ApiClient.uploadFile('media_out.gif');
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
      process.exit(1);
      return;
    } else if (['.jpg', '.webp', '.jpeg', '.png'].includes(extName)) {
      // 处理图像文件
      let outFilePath = 'media_out.jpg';
      let mediaFilePath = 'media.jpg';
      MediaProcessor.addWatermarkToImage(inputFilename, mediaFilePath);

      await MediaProcessor.procImage(
        mediaFilePath, faceFilename, outFilePath, isEnhancement, params.reference_face?1:0
      );
      
      const thumbFilePath = 'thumb_media.jpg';
      MediaProcessor.generateImgThumbnail(outFilePath, thumbFilePath);

      if (!fs.existsSync(outFilePath)) {
        console.log(`Cannot find file ${outFilePath}`);
   //     await ApiClient.addLog(this.taskData, true, -1, 'Processing failed', 99);
        return;
      }
      
      const uploadFileUrl = await ApiClient.uploadFile(outFilePath);
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
      process.exit(1);
    }
  }
}

// 主程序入口
async function main() {
  const worker = new Worker();
  await worker.work();
}


  main().catch(error => {
    console.error('Error in main program:', error);
    process.exit(1);
  });


