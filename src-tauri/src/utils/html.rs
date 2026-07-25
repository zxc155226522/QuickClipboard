// HTML 处理工具函数

use once_cell::sync::Lazy;
use regex::Regex;

/// 匹配所有 HTML 标签，如 `<div>`、`</span>`、`<img src="...">`
pub static TAG_REGEX: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"<[^>]*>").unwrap());

/// 匹配 HTML 实体，如 `&nbsp;`、`&lt;`、`&amp;`
pub static ENTITY_REGEX: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"&[a-zA-Z]+;").unwrap());

/// 匹配连续空白字符
pub static WHITESPACE_REGEX: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\s+").unwrap());

/// 检测文本中是否包含 URL 链接（不区分大小写）
pub static URL_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\b(https?://|ftp://|www\.)[^\s<>"]+\b"#).unwrap()
});

/// 提取 `<img src="xxx">` 中双引号包裹的 src 值
pub static IMG_SRC_DOUBLE_QUOTE_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(<img\b[^>]*?\bsrc\s*=\s*")([^"]+)(")"#).unwrap()
});

/// 提取 `<img src='xxx'>` 中单引号包裹的 src 值
pub static IMG_SRC_SINGLE_QUOTE_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(<img\b[^>]*?\bsrc\s*=\s*')([^']+)(')"#).unwrap()
});

pub fn truncate_html(html: String, max_visible_len: usize) -> String {
    if html.is_empty() {
        return html;
    }
    
    if max_visible_len == 0 {
        return "...(内容过长已截断)".to_string();
    }
    
    let mut visible_count: usize = 0;
    let mut in_tag = false;
    
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => {
                visible_count = visible_count.saturating_add(1);
                if visible_count > max_visible_len {
                    break;
                }
            }
            _ => {}
        }
    }
    
    if visible_count <= max_visible_len {
        return html;
    }
    
    let mut result = String::with_capacity(html.len().min(max_visible_len * 10));
    visible_count = 0;
    in_tag = false;
    let mut open_tags: Vec<String> = Vec::with_capacity(16);
    let mut current_tag = String::with_capacity(32);
    let mut is_closing_tag = false;
    let mut tag_started = false;
    
    for c in html.chars() {
        if c == '<' {
            in_tag = true;
            tag_started = false;
            is_closing_tag = false;
            current_tag.clear();
            result.push(c);
        } else if c == '>' {
            in_tag = false;
            result.push(c);
            
            if !current_tag.is_empty() {
                let tag_name = current_tag.to_lowercase();
                let is_self_closing = matches!(tag_name.as_str(), 
                    "br" | "hr" | "img" | "input" | "meta" | "link" | "area" | "base" | "col" | "embed" | "source" | "track" | "wbr");
                
                if !is_self_closing {
                    if is_closing_tag {
                        if let Some(pos) = open_tags.iter().rposition(|t| t == &tag_name) {
                            open_tags.remove(pos);
                        }
                    } else {
                        if open_tags.len() < 100 {
                            open_tags.push(tag_name);
                        }
                    }
                }
            }
        } else if in_tag {
            result.push(c);
            
            if c == '/' && !tag_started {
                is_closing_tag = true;
            } else if c.is_alphanumeric() && !tag_started {
                tag_started = true;
                if current_tag.len() < 50 {
                    current_tag.push(c);
                }
            } else if tag_started && (c.is_alphanumeric() || c == '-') {
                if current_tag.len() < 50 {
                    current_tag.push(c);
                }
            } else if tag_started {
                tag_started = false;
            }
        } else {
            visible_count = visible_count.saturating_add(1);
            if visible_count > max_visible_len {
                break;
            }
            result.push(c);
        }
    }
    
    for tag in open_tags.iter().rev().take(50) {
        result.push_str("</");
        result.push_str(tag);
        result.push('>');
    }
    result.push_str("...(内容过长已截断)");
    
    result
}
