#!/bin/bash
if [ -z "$1" ]; then
    echo "使用方法: ./generate_webp_sprite.sh 视频文件路径"
    exit 1
fi

VIDEO_FILE="$1"
SPRITE_IMAGE="out.webp"
FRAME_COUNT=100  # 固定抽取100帧

rm -f "$SPRITE_IMAGE"

# 缩略图尺寸
WIDTH=256
HEIGHT=144


extract_video_info() {
    local video_file="$1"
    local thumb_format="${2:-webp}"  # 默认使用webp，可以指定jpg
    
    local base_name="${video_file%.*}"
    local webp_file="thumb.webp"
    local jpg_file="thumb.jpg"
    local thumb_file=""
    local json_file="video_info.json"
    local temp_json="/tmp/ffprobe_$(date +%s%N).json"

    rm -f "$webp_file"
    rm -f "$jpg_file"
    rm -f "$json_file"
    
    # 检查文件是否存在
    if [ ! -f "$video_file" ]; then
        echo "错误: 文件 '$video_file' 不存在" >&2
        return 1
    fi
    
    echo "处理文件: $video_file"
    
    # 一次性获取所有视频信息，以JSON格式输出
    ffprobe -v error \
           -select_streams v:0 \
           -show_entries stream=codec_name,width,height,r_frame_rate,duration,display_aspect_ratio \
           -show_entries format=size,bit_rate \
           -of json \
           "$video_file" > "$temp_json"
    
    if [ ! -s "$temp_json" ]; then
        echo "错误: 无法提取视频信息" >&2
        rm -f "$temp_json"
        return 1
    fi
    
    # 提取信息 (使用基本shell命令，确保最大兼容性)
    local format=$(grep -o '"codec_name": *"[^"]*"' "$temp_json" | head -1 | sed 's/.*"codec_name": *"\([^"]*\)".*/\1/')
    local width=$(grep -o '"width": *[0-9]*' "$temp_json" | head -1 | sed 's/.*"width": *\([0-9]*\).*/\1/')
    local height=$(grep -o '"height": *[0-9]*' "$temp_json" | head -1 | sed 's/.*"height": *\([0-9]*\).*/\1/')
    local frame_rate=$(grep -o '"r_frame_rate": *"[^"]*"' "$temp_json" | head -1 | sed 's/.*"r_frame_rate": *"\([^"]*\)".*/\1/')
    local duration=$(grep -o '"duration": *"[^"]*"' "$temp_json" | head -1 | sed 's/.*"duration": *"\([^"]*\)".*/\1/')
    local aspect_ratio=$(grep -o '"display_aspect_ratio": *"[^"]*"' "$temp_json" | head -1 | sed 's/.*"display_aspect_ratio": *"\([^"]*\)".*/\1/')
    local file_size=$(grep -o '"size": *"[^"]*"' "$temp_json" | head -1 | sed 's/.*"size": *"\([^"]*\)".*/\1/')
    local bit_rate=$(grep -o '"bit_rate": *"[^"]*"' "$temp_json" | head -1 | sed 's/.*"bit_rate": *"\([^"]*\)".*/\1/')
    
    # 计算总帧数 (帧率可能是分数形式如 "30/1")
    local total_frames=0
    if [[ $frame_rate == *"/"* ]]; then
        local numerator=$(echo $frame_rate | cut -d'/' -f1)
        local denominator=$(echo $frame_rate | cut -d'/' -f2)
        local fps_value=$(echo "scale=6; $numerator / $denominator" | bc)
        total_frames=$(echo "scale=0; $duration * $fps_value" | bc)
    else
        total_frames=$(echo "scale=0; $duration * $frame_rate" | bc)
    fi
    
    # 计算可读的文件大小
    local readable_size=""
    if [ ! -z "$file_size" ]; then
        if [ "$file_size" -gt 1073741824 ]; then # 1GB
            readable_size=$(echo "scale=2; $file_size/1073741824" | bc)" GB"
        elif [ "$file_size" -gt 1048576 ]; then # 1MB
            readable_size=$(echo "scale=2; $file_size/1048576" | bc)" MB"
        elif [ "$file_size" -gt 1024 ]; then # 1KB
            readable_size=$(echo "scale=2; $file_size/1024" | bc)" KB"
        else
            readable_size="$file_size bytes"
        fi
    fi
    
    # 计算可读的时长
    local readable_duration=""
    if [ ! -z "$duration" ] && [ "$duration" != "N/A" ]; then
        local total_seconds=$(echo "$duration" | bc)
        local hours=$(echo "$total_seconds/3600" | bc)
        local minutes=$(echo "($total_seconds%3600)/60" | bc)
        local seconds=$(echo "$total_seconds%60" | bc)
        readable_duration=$(printf "%02d:%02d:%02d" $hours $minutes $seconds)
    fi
    
    # 生成封面图 - 首先尝试预期的格式
    echo "生成480p封面图(确保偶数分辨率)..."
    local cover_success=false
    local cover_filename=""
    
    # 检查是否支持webp编码器
    local has_webp=false
    if ffmpeg -encoders 2>/dev/null | grep -q "libwebp"; then
        has_webp=true
    fi
    
    # 确保高度为偶数（如果需要的话）
    local target_height=480
    if [ $((target_height % 2)) -ne 0 ]; then
        target_height=$((target_height + 1))
    fi
    
    # 使用特殊的缩放滤镜确保宽度为偶数
    local scale_filter="scale='trunc(oh*a/2)*2:$target_height'"
    
    if [ "$thumb_format" = "webp" ] && [ "$has_webp" = true ]; then
        echo "尝试生成WebP格式封面图(${target_height}p, 偶数宽高)..."
        
        # 尝试生成WebP封面 - 使用确保偶数宽高的滤镜
        if ffmpeg -y -i "$video_file" -ss 00:00:02 -vframes 1 -vf "$scale_filter" -c:v libwebp -preset picture -compression_level 6 -qscale 80 "$webp_file" 2>&1; then
            echo "WebP封面图生成成功: $webp_file"
            cover_success=true
            cover_filename="$(basename "$webp_file")"
            thumb_file="$webp_file"
            
            # 获取生成的封面图尺寸
            local thumb_info=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=,:p=0 "$webp_file" 2>/dev/null)
            if [ ! -z "$thumb_info" ]; then
                echo "封面图实际尺寸: $thumb_info"
            fi
        else
            echo "WebP封面图生成失败，将尝试JPG格式..."
        fi
    fi
    
    # 如果WebP失败或未指定WebP，尝试生成JPG封面
    if [ "$cover_success" = false ]; then
        echo "生成JPG格式封面图(${target_height}p, 偶数宽高)..."
        # 使用确保偶数宽高的滤镜
        if ffmpeg -y -i "$video_file" -ss 00:00:02 -vframes 1 -vf "$scale_filter" -q:v 2 "$jpg_file" 2>&1; then
            echo "JPG封面图生成成功: $jpg_file"
            cover_success=true
            cover_filename="$(basename "$jpg_file")"
            thumb_file="$jpg_file"
            
            # 获取生成的封面图尺寸
            local thumb_info=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=,:p=0 "$jpg_file" 2>/dev/null)
            if [ ! -z "$thumb_info" ]; then
                echo "封面图实际尺寸: $thumb_info"
            fi
        else
            echo "JPG封面图生成也失败，请检查视频文件或FFmpeg安装..."
        fi
    fi
    
    # 创建JSON对象
    echo "生成JSON文件: $json_file"
    cat > "$json_file" << EOF
{
    "fileName": "$(basename "$video_file")",
    "codec": "$format",
    "width": $width,
    "height": $height,
    "resolution": "${width}x${height}",
    "aspectRatio": "$aspect_ratio",
    "duration": $duration,
    "durationFormatted": "$readable_duration",
    "frameRate": "$frame_rate",
    "frameRateDecimal": "$(echo "scale=3; $frame_rate" | bc 2>/dev/null || echo "$frame_rate")",
    "totalFrames": $total_frames,
    "bitRate": "$bit_rate",
    "fileSize": $file_size,
    "fileSizeFormatted": "$readable_size",
    "coverImage": $([ "$cover_success" = true ] && echo "\"$cover_filename\"" || echo "null"),
    "coverResolution": "${target_height}p (偶数宽高)",
    "extractedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
    
    # 清理临时文件
    rm -f "$temp_json"
    
    # 输出简要信息
    echo "处理完成!"
    echo "- 分辨率: ${width}x${height}"
    echo "- 时长: $readable_duration"
    echo "- 帧率: $frame_rate (约 $(echo "scale=3; $frame_rate" | bc 2>/dev/null || echo "$frame_rate") fps)"
    echo "- 总帧数: $total_frames"
    echo "- 大小: $readable_size"
    echo "- 编解码器: $format"
    if [ "$cover_success" = true ]; then
        echo "- 封面图: $thumb_file (${target_height}p, 偶数宽高)"
    else
        echo "- 封面图: 生成失败"
    fi
    
    return 0
}

# 检查FFmpeg是否支持WebP编码
check_webp_support() {
    if ffmpeg -encoders 2>/dev/null | grep -q "libwebp"; then
        echo "您的FFmpeg安装支持WebP编码。"
        return 0
    else
        echo "您的FFmpeg安装不支持WebP编码。将使用JPG作为备选方案。"
        return 1
    fi
}

# 主函数
main() {
    # 检查命令
    if ! command -v ffprobe &>/dev/null || ! command -v ffmpeg &>/dev/null; then
        echo "错误: 需要安装FFmpeg工具包" >&2
        echo "  Ubuntu/Debian: sudo apt install ffmpeg" >&2
        echo "  CentOS/RHEL: sudo yum install ffmpeg" >&2
        echo "  macOS: brew install ffmpeg" >&2
        exit 1
    fi
    
    # 检查bc计算器是否可用
    if ! command -v bc &>/dev/null; then
        echo "警告: 未找到bc计算器，某些计算可能不准确" >&2
    fi
    
    # 检查参数
    if [ $# -eq 0 ]; then
        echo "用法: $0 <视频文件或目录> [jpg|webp]" >&2
        exit 1
    fi
    
    local target="$1"
    local format="${2:-webp}"  # 默认使用webp
    
    # 验证格式参数
    if [ "$format" != "jpg" ] && [ "$format" != "webp" ]; then
        echo "警告: 未知的封面格式 '$format'，将使用默认的WebP格式"
        format="webp"
    fi
    
    # 如果指定了WebP格式，检查是否支持
    if [ "$format" = "webp" ]; then
        check_webp_support
        if [ $? -ne 0 ]; then
            echo "将使用JPG格式作为备选..."
            format="jpg"
        fi
    fi
    
    # 检查目标是文件还是目录
    if [ -f "$target" ]; then
        # 处理单个文件
        extract_video_info "$target" "$format"
    elif [ -d "$target" ]; then
        # 处理目录中的所有视频文件
        echo "处理目录: $target"
        echo "查找视频文件..."
        
        # 统计总数
        local total=$(find "$target" -type f \( -name "*.mp4" -o -name "*.mov" -o -name "*.avi" -o -name "*.mkv" \) | wc -l)
        echo "找到 $total 个视频文件"
        
        local count=0
        find "$target" -type f \( -name "*.mp4" -o -name "*.mov" -o -name "*.avi" -o -name "*.mkv" \) | while read video; do
            count=$((count + 1))
            echo "========================================================"
            echo "[$count/$total] 处理: $video"
            extract_video_info "$video" "$format"
        done
        
        echo "所有文件处理完成!"
    else
        echo "错误: '$target' 不是有效的文件或目录" >&2
        exit 1
    fi
}



# 获取视频时长
duration=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$VIDEO_FILE")

# 获取帧率
fps=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=noprint_wrappers=1:nokey=1 "$VIDEO_FILE")

# 处理帧率（可能是分数形式如 "30/1"）
if [[ $fps == *"/"* ]]; then
  numerator=$(echo $fps | cut -d'/' -f1)
  denominator=$(echo $fps | cut -d'/' -f2)
  fps_value=$(echo "scale=6; $numerator / $denominator" | bc)
else
  fps_value=$fps
fi

# 计算预估总帧数
total_frames=$(echo "scale=0; $duration * $fps_value" | bc)

# 计算帧间隔
frame_interval=$(echo "scale=0; $total_frames / $FRAME_COUNT" | bc)

# 确保frame_interval至少为1
[ "$frame_interval" -lt 1 ] && frame_interval=1

echo "视频长度: $duration 秒"
echo "帧率: $fps ($fps_value fps)"
echo "预估总帧数: $total_frames"
echo "帧间隔: 每隔 $frame_interval 帧抽取一帧"

# 使用select过滤器按帧间隔抽取
echo "处理中..."
ffmpeg -v warning -i "$VIDEO_FILE" \
    -vf "select='not(mod(n,$frame_interval))',scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},tile=10x10" \
    -frames:v 1 -c:v libwebp -compression_level 6 -quality 60 -preset picture -threads 4 \
    "$SPRITE_IMAGE"

FILE_SIZE=$(du -h "$SPRITE_IMAGE" | cut -f1)

extract_video_info "$VIDEO_FILE"
echo "✅ 已生成WebP雪碧图: $SPRITE_IMAGE (大小: $FILE_SIZE)"
