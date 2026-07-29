// 判断是否是图片文件
pub fn is_image_file(path: &str) -> bool {
    let path_lower = path.to_lowercase();
    path_lower.ends_with(".jpg") ||
    path_lower.ends_with(".jpeg") ||
    path_lower.ends_with(".png") ||
    path_lower.ends_with(".gif") ||
    path_lower.ends_with(".bmp") ||
    path_lower.ends_with(".webp") ||
    path_lower.ends_with(".tif") ||
    path_lower.ends_with(".tiff")
}

// 读取图片尺寸
pub fn get_image_dimensions(path: &str) -> Option<(u32, u32)> {
    use std::fs::File;
    use std::io::BufReader;
    use image::ImageReader;
    
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    let img_reader = ImageReader::new(reader).with_guessed_format().ok()?;
    img_reader.into_dimensions().ok()
}

/// 生成缩略图的 base64 data URL。
/// 读取图片文件 → 如果宽度超过 max_width 则 Lanczos3 缩放 → 编码 JPEG base64 → 返回 data URL。
/// 所有中间数据（file_data、img、thumbnail）在各自作用域结束后立即释放。
pub fn generate_thumbnail_data_url(path: &str, max_width: u32, max_size_mb: u64) -> Result<String, String> {
    use base64::{Engine as _, engine::general_purpose};
    use image::ImageFormat;
    use std::io::Cursor;

    // 小图片直接返回空字符串，前端自动回退到高清原图
    let size_threshold = max_size_mb * 1024 * 1024;

    if let Ok(metadata) = std::fs::metadata(path) {
        if metadata.len() < size_threshold {
            return Ok(String::new());
        }
    }

    // 读取文件数据
    let file_data = std::fs::read(path)
        .map_err(|e| format!("读取图片失败: {}", e))?;

    // 解码并缩放，img 在 block 结束后释放
    let thumbnail = {
        let img = image::load_from_memory(&file_data)
            .map_err(|e| format!("解码图片失败: {}", e))?;
        if img.width() > max_width {
            img.resize(max_width, u32::MAX, image::imageops::FilterType::Lanczos3)
        } else {
            img
        }
    };

    // file_data 不再需要，提前释放
    drop(file_data);

    // 编码为 JPEG
    let mut buf = Vec::new();
    {
        let mut cursor = Cursor::new(&mut buf);
        thumbnail.write_to(&mut cursor, ImageFormat::Jpeg)
            .map_err(|e| format!("编码缩略图失败: {}", e))?;
    }

    let b64 = general_purpose::STANDARD.encode(&buf);
    Ok(format!("data:image/jpeg;base64,{}", b64))
}
