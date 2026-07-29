use file_icon_provider::get_file_icon;
use image::{RgbaImage, ImageFormat};
use std::io::Cursor;
use sha2::{Sha256, Digest};

/// 缩略图尺寸（像素）
const THUMBNAIL_SIZE: u16 = 256;
/// 缓存过期时间（天）
const CACHE_EXPIRY_DAYS: u64 = 30;
/// 缓存目录大小上限（字节），1 GB
const CACHE_MAX_SIZE_BYTES: u64 = 1024 * 1024 * 1024;

// ==================== 原有：小图标（base64）====================

// 获取文件图标并转换为 Base64 Data URL
pub fn get_file_icon_base64(path: &str) -> Option<String> {
    match get_file_icon(path, 32) {
        Ok(icon) => {
            if let Ok(png_data) = icon_to_png(&icon) {
                use base64::{Engine as _, engine::general_purpose};
                let base64_str = general_purpose::STANDARD.encode(&png_data);
                return Some(format!("data:image/png;base64,{}", base64_str));
            }
            None
        }
        Err(_) => None,
    }
}

// 将 Icon 转换为 PNG 格式
pub fn icon_to_png(icon: &file_icon_provider::Icon) -> Result<Vec<u8>, String> {
    let img = RgbaImage::from_raw(icon.width, icon.height, icon.pixels.clone())
        .ok_or("创建图像失败")?;
    
    let mut png_data = Vec::new();
    let mut cursor = Cursor::new(&mut png_data);
    img.write_to(&mut cursor, ImageFormat::Png)
        .map_err(|e| format!("PNG编码失败: {}", e))?;
    
    Ok(png_data)
}

// 计算图标哈希
fn calculate_icon_hash(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let hash = format!("{:x}", hasher.finalize());
    hash[..16].to_string()
}

// 保存应用图标到 app_icons 目录
pub fn save_app_icon(exe_path: &str) -> Option<String> {
    let icon = match get_file_icon(exe_path, 32) {
        Ok(icon) => icon,
        Err(_) => return None,
    };
    
    let png_data = match icon_to_png(&icon) {
        Ok(data) => data,
        Err(_) => return None,
    };

    let hash = calculate_icon_hash(&png_data);

    let data_dir = match crate::services::get_data_directory() {
        Ok(dir) => dir,
        Err(_) => return None,
    };

    let icons_dir = data_dir.join("app_icons");
    if !icons_dir.exists() {
        if std::fs::create_dir_all(&icons_dir).is_err() {
            return None;
        }
    }

    let icon_path = icons_dir.join(format!("{}.png", hash));
    if !icon_path.exists() {
        if std::fs::write(&icon_path, &png_data).is_err() {
            return None;
        }
    }
    
    Some(hash)
}

// ==================== 新增：文件缩略图（文件缓存）====================

/// 获取或创建文件缩略图，返回绝对路径（用于前端 convertFileSrc）
/// 
/// 策略：
/// 1. 图片文件：读取原图生成缩略图
/// 2. 其他文件：使用 file_icon_provider 获取系统图标
/// 3. 所有结果缓存到 file_thumbnails/ 目录，30天过期，1GB上限
pub fn get_or_create_file_thumbnail(file_path: &str) -> Option<String> {
    let path = std::path::Path::new(file_path);
    if !path.exists() {
        return None;
    }

    // 读取文件元数据用于计算缓存键
    let metadata = std::fs::metadata(path).ok()?;
    let modified_time = metadata.modified().ok()?;
    let file_size = metadata.len();

    // 计算缓存键
    let cache_key = calculate_thumbnail_cache_key(file_path, &modified_time, file_size);

    // 确定缓存目录
    let data_dir = crate::services::get_data_directory().ok()?;
    let thumbs_dir = data_dir.join("file_thumbnails");
    
    // 检查缓存是否存在且未过期
    let cached_path = thumbs_dir.join(format!("{}.png", cache_key));
    if cached_path.exists() && !is_file_expired(&cached_path, CACHE_EXPIRY_DAYS) {
        // 返回绝对路径，前端可用 convertFileSrc 转换
        return Some(cached_path.to_string_lossy().to_string());
    }

    // 缓存未命中：创建目录并提取缩略图
    if std::fs::create_dir_all(&thumbs_dir).is_err() {
        return None;
    }

    // 根据文件类型选择提取策略
    let thumbnail_data = if crate::utils::is_image_file(file_path) {
        // 图片文件：生成缩略图
        generate_image_thumbnail(file_path)
    } else {
        // 非图片文件：使用系统图标（48px 足够清晰且性能好）
        get_file_icon(file_path, 48)
            .ok()
            .and_then(|icon| icon_to_png(&icon).ok())
    };

    if let Some(data) = thumbnail_data {
        if std::fs::write(&cached_path, &data).is_ok() {
            // 返回绝对路径
            return Some(cached_path.to_string_lossy().to_string());
        }
    }

    None
}

/// 清理过期的缩略图缓存文件
pub fn cleanup_thumbnail_cache() -> (u64, u64) {
    let data_dir = match crate::services::get_data_directory() {
        Ok(dir) => dir,
        Err(_) => return (0, 0),
    };
    let thumbs_dir = data_dir.join("file_thumbnails");
    if !thumbs_dir.exists() {
        return (0, 0);
    }

    let now = std::time::SystemTime::now();
    let mut expired_count = 0u64;
    let mut total_size = 0u64;
    let mut entries: Vec<(std::path::PathBuf, std::time::SystemTime, u64)> = Vec::new();

    if let Ok(read_dir) = std::fs::read_dir(&thumbs_dir) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            if !path.is_file() { continue; }

            let meta = match std::fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };

            let size = meta.len();
            total_size += size;

            if let Ok(modified) = meta.modified() {
                let age_days = now.duration_since(modified)
                    .map(|d| d.as_secs() / 86400)
                    .unwrap_or(u64::MAX);

                if age_days >= CACHE_EXPIRY_DAYS {
                    let _ = std::fs::remove_file(&path);
                    expired_count += 1;
                    total_size -= size;
                } else {
                    entries.push((path, modified, size));
                }
            }
        }
    }

    // 超过上限时 LRU 清理
    if total_size > CACHE_MAX_SIZE_BYTES && !entries.is_empty() {
        entries.sort_by(|a, b| a.1.cmp(&b.1));
        for (path, _, size) in entries.iter() {
            if total_size <= CACHE_MAX_SIZE_BYTES { break; }
            let _ = std::fs::remove_file(path);
            total_size -= size;
            expired_count += 1;
        }
    }

    (expired_count, total_size)
}

// ==================== 内部辅助函数 =====================

fn calculate_thumbnail_cache_key(file_path: &str, modified: &std::time::SystemTime, file_size: u64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(file_path.as_bytes());
    if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
        hasher.update(duration.as_nanos().to_le_bytes());
    }
    hasher.update(file_size.to_le_bytes());
    let hash = format!("{:x}", hasher.finalize());
    hash[..20].to_string()
}

fn is_file_expired(path: &std::path::Path, max_age_days: u64) -> bool {
    let metadata = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return true,
    };
    let modified = match metadata.modified() {
        Ok(t) => t,
        Err(_) => return true,
    };
    let age_secs = std::time::SystemTime::now()
        .duration_since(modified)
        .map(|d| d.as_secs())
        .unwrap_or(u64::MAX);
    age_secs > max_age_days * 86400
}

/// 为图片文件生成缩略图 PNG 数据
/// 
/// 始终生成缩略图（无论文件大小），保证所有图片都有缩略图显示
fn generate_image_thumbnail(image_path: &str) -> Option<Vec<u8>> {
    use image::ImageFormat;
    use image::imageops::FilterType;

    // 读取图片文件
    let file_data = std::fs::read(image_path).ok()?;
    
    // 解码图片
    let img = image::load_from_memory(&file_data).ok()?;
    
    // 缩放到目标尺寸（保持宽高比）
    let thumbnail = if img.width() > THUMBNAIL_SIZE as u32 || img.height() > THUMBNAIL_SIZE as u32 {
        img.resize(THUMBNAIL_SIZE as u32, THUMBNAIL_SIZE as u32, FilterType::Lanczos3)
    } else {
        img
    };
    
    // 编码为 PNG 格式
    let mut png_data = Vec::new();
    {
        let mut cursor = Cursor::new(&mut png_data);
        thumbnail.write_to(&mut cursor, ImageFormat::Png).ok()?;
    }
    
    Some(png_data)
}
