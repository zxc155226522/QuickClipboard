use once_cell::sync::Lazy;
use serde::Serialize;
use serde::Deserialize;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const PREVIEW_WINDOW_LABEL: &str = "preview-window";
const PREVIEW_REUSE_TTL_MS: u64 = 60_000;
const PREVIEW_ALWAYS_ON_TOP_REFRESH_DELAY_MS: u64 = 10;
const PREVIEW_HIDE_WATCHDOG_DURATION_MS: u64 = 5_000;
const PREVIEW_HIDE_WATCHDOG_INTERVAL_MS: u64 = 100;

// 悬浮预览窗固定尺寸（逻辑像素）
const PREVIEW_WINDOW_DEFAULT_WIDTH: u32 = 640;
const PREVIEW_WINDOW_DEFAULT_HEIGHT: u32 = 480;
const PREVIEW_WINDOW_MIN_WIDTH: u32 = 240;
const PREVIEW_WINDOW_MIN_HEIGHT: u32 = 200;
const PREVIEW_WINDOW_MAX_WIDTH: u32 = 1920;
const PREVIEW_WINDOW_MAX_HEIGHT: u32 = 1200;
const PREVIEW_MAIN_GAP_LOGICAL: i32 = 2;
const PREVIEW_CURSOR_OFFSET: i32 = 16;

static PREVIEW_REQUEST_VERSION: AtomicU64 = AtomicU64::new(0);
static PREVIEW_DESTROY_TIMER_VERSION: AtomicU64 = AtomicU64::new(0);
static PREVIEW_HIDE_WATCHDOG_VERSION: AtomicU64 = AtomicU64::new(0);
static PREVIEW_SUPPRESSED: AtomicBool = AtomicBool::new(false);
static PREVIEW_PINNED: AtomicBool = AtomicBool::new(false);
static PREVIEW_DATA: Lazy<Mutex<Option<PreviewWindowData>>> = Lazy::new(|| Mutex::new(None));

fn clamp_i32(value: i32, min: i32, max: i32) -> i32 {
  if min > max {
    return min;
  }
  value.min(max).max(min)
}

/// 计算悬浮预览窗的物理矩形（左上角坐标 + 宽高），尽量放在主窗口右侧，
/// 其次左侧，否则靠近光标；最终夹取到工作区内。
#[allow(clippy::too_many_arguments)]
fn resolve_preview_window_rect(
  work_area_x: i32,
  work_area_y: i32,
  work_area_width: u32,
  work_area_height: u32,
  main_window: Option<(i32, i32, u32, u32)>,
  cursor_x: i32,
  cursor_y: i32,
  width: u32,
  height: u32,
  scale_factor: f64,
) -> (i32, i32, u32, u32) {
  let wa_left = work_area_x;
  let wa_top = work_area_y;
  let wa_right = wa_left + work_area_width as i32;
  let wa_bottom = wa_top + work_area_height as i32;

  let width = width.min((work_area_width.saturating_sub(8)).max(PREVIEW_WINDOW_MIN_WIDTH));
  let height = height.min((work_area_height.saturating_sub(8)).max(PREVIEW_WINDOW_MIN_HEIGHT));

  let main_gap = (PREVIEW_MAIN_GAP_LOGICAL as f64 * scale_factor).round() as i32;

  let mut left = cursor_x + PREVIEW_CURSOR_OFFSET;
  let mut top = cursor_y + PREVIEW_CURSOR_OFFSET;

  if let Some((mw_x, mw_y, mw_w, mw_h)) = main_window {
    let mw_right = mw_x + mw_w as i32;
    let mw_left = mw_x;
    let mw_top = mw_y;
    let mw_bottom = mw_y + mw_h as i32;

    let right_target = mw_right + main_gap;
    let left_target = mw_left - main_gap - width as i32;
    let can_right = right_target + width as i32 <= wa_right;
    let can_left = left_target >= wa_left;

    if can_right || can_left {
      left = if can_right && (!can_left || (right_target + width as i32) <= wa_right) {
        right_target
      } else {
        left_target
      };
      let preferred_top = cursor_y - height as i32 / 2;
      top = clamp_i32(preferred_top, mw_top, mw_bottom.saturating_sub(height as i32).max(mw_top));
    }
  }

  left = clamp_i32(left, wa_left, wa_right.saturating_sub(width as i32).max(wa_left));
  top = clamp_i32(top, wa_top, wa_bottom.saturating_sub(height as i32).max(wa_top));

  (left, top, width, height)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewAnchorRect {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct PreviewWindowData {
    pub mode: String,
    pub source: String,
    pub item_id: String,
    pub cursor_x: i32,
    pub cursor_y: i32,
    pub scale_factor: f64,
    pub work_area_x: i32,
    pub work_area_y: i32,
    pub work_area_width: u32,
    pub work_area_height: u32,
    pub main_window_x: i32,
    pub main_window_y: i32,
    pub main_window_width: u32,
    pub main_window_height: u32,
    pub item_rect: Option<PreviewAnchorRect>,
    pub request_id: u64,
}

fn destroy_preview_window_internal(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PREVIEW_WINDOW_LABEL) {
        let _ = window.hide();
        let _ = window.close();
    }
    if let Ok(mut guard) = PREVIEW_DATA.lock() {
        *guard = None;
    }
    PREVIEW_PINNED.store(false, Ordering::SeqCst);
}

fn hide_preview_window_internal(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PREVIEW_WINDOW_LABEL) {
        let _ = window.hide();
    }
}

fn refresh_preview_window_always_on_top(window: &WebviewWindow) -> Result<(), String> {
    window
        .set_always_on_top(false)
        .map_err(|e| format!("取消预览窗口置顶失败: {}", e))?;
    std::thread::sleep(std::time::Duration::from_millis(
        PREVIEW_ALWAYS_ON_TOP_REFRESH_DELAY_MS,
    ));
    window
        .set_always_on_top(true)
        .map_err(|e| format!("恢复预览窗口置顶失败: {}", e))?;
    Ok(())
}

fn apply_preview_window_rect(
    window: &WebviewWindow,
    rect: (i32, i32, u32, u32),
) -> Result<(), String> {
    let (phys_x, phys_y, phys_w, phys_h) = rect;
    window
        .set_position(PhysicalPosition::new(phys_x, phys_y))
        .map_err(|e| format!("设置预览窗口位置失败: {}", e))?;
    window
        .set_size(PhysicalSize::new(phys_w, phys_h))
        .map_err(|e| format!("设置预览窗口大小失败: {}", e))?;
    Ok(())
}

fn upsert_preview_data(data: PreviewWindowData) {
    if let Ok(mut guard) = PREVIEW_DATA.lock() {
        *guard = Some(data);
    }
}

fn schedule_preview_window_destroy(app: AppHandle, timer_version: u64, request_id: u64) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(PREVIEW_REUSE_TTL_MS)).await;

        if PREVIEW_DESTROY_TIMER_VERSION.load(Ordering::SeqCst) != timer_version {
            return;
        }

        let current_request_id = PREVIEW_DATA
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|data| data.request_id))
            .unwrap_or_default();

        if current_request_id != request_id {
            return;
        }

        // 只隐藏而非销毁，保持 WebView2 控制器存活，避免反复创建触发 wry 空指针崩溃。
        hide_preview_window_internal(&app);
    });
}

fn schedule_preview_hide_watchdog(app: AppHandle, watchdog_version: u64) {
    tauri::async_runtime::spawn(async move {
        let started_at = Instant::now();

        loop {
            if PREVIEW_HIDE_WATCHDOG_VERSION.load(Ordering::SeqCst) != watchdog_version {
                return;
            }

            if !PREVIEW_SUPPRESSED.load(Ordering::SeqCst) {
                return;
            }

            if started_at.elapsed() >= Duration::from_millis(PREVIEW_HIDE_WATCHDOG_DURATION_MS) {
                return;
            }

            if app.get_webview_window(PREVIEW_WINDOW_LABEL).is_some() {
                hide_preview_window_internal(&app);
            }

            tokio::time::sleep(Duration::from_millis(
                PREVIEW_HIDE_WATCHDOG_INTERVAL_MS,
            ))
            .await;
        }
    });
}

fn create_preview_window(
    app: &AppHandle,
    rect: (i32, i32, u32, u32),
    scale_factor: f64,
) -> Result<WebviewWindow, String> {
    let (phys_x, phys_y, phys_w, phys_h) = rect;
    let logical_scale = if scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let logical_x = phys_x as f64 / logical_scale;
    let logical_y = phys_y as f64 / logical_scale;
    let logical_width = (phys_w as f64 / logical_scale).max(1.0);
    let logical_height = (phys_h as f64 / logical_scale).max(1.0);

    let window = WebviewWindowBuilder::new(
        app,
        PREVIEW_WINDOW_LABEL,
        WebviewUrl::App("windows/preview/index.html".into()),
    )
    .title("预览窗口")
    .inner_size(logical_width, logical_height)
    .position(logical_x, logical_y)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .focusable(true)
    .visible(false)
    .drag_and_drop(false)
    .build()
    .map_err(|e| format!("创建预览窗口失败: {}", e))?;

    // 注意：不再调用 set_ignore_cursor_events，悬浮窗现在是可交互的固定大小窗口，
    // 鼠标事件（滚轮缩放 / 滚动 / 点击按钮）需要正常接收。

    Ok(window)
}

#[tauri::command]
pub async fn show_preview_window(
    app: AppHandle,
    mode: String,
    source: String,
    item_id: String,
    item_rect: Option<PreviewAnchorRect>,
    preview_width: Option<u32>,
    preview_height: Option<u32>,
) -> Result<(), String> {
    if PREVIEW_SUPPRESSED.load(Ordering::SeqCst) {
        return Ok(());
    }

    // 已固定时忽略新的预览请求，保持当前内容
    if PREVIEW_PINNED.load(Ordering::SeqCst) {
        return Ok(());
    }

    if crate::is_context_menu_visible() {
        return Ok(());
    }

    let window_state = crate::get_window_state();
    if window_state.state != crate::WindowState::Visible {
        return Ok(());
    }

    let request_id = PREVIEW_REQUEST_VERSION.fetch_add(1, Ordering::SeqCst) + 1;
    PREVIEW_DESTROY_TIMER_VERSION.fetch_add(1, Ordering::SeqCst);

    let monitor = crate::utils::screen::ScreenUtils::get_monitor_at_cursor(&app)?;
    let work_area = monitor.work_area();
    let scale_factor = monitor.scale_factor();
    let (cursor_x, cursor_y) = crate::mouse::get_cursor_position();
    let work_area_x = work_area.position.x;
    let work_area_y = work_area.position.y;
    let work_area_width = work_area.size.width;
    let work_area_height = work_area.size.height;
    let (main_window_x, main_window_y, main_window_width, main_window_height) =
        app.get_webview_window("main")
            .and_then(|window| crate::get_window_bounds(&window).ok())
            .unwrap_or((0, 0, 0, 0));

    // 前端传入的尺寸为逻辑像素(CSS px,与设置面板 / 窗口 innerWidth 一致),
    // 但本窗口定位与 set_size 均使用物理像素,这里统一换算为物理像素。
    let requested_width = preview_width
        .unwrap_or(0)
        .clamp(PREVIEW_WINDOW_MIN_WIDTH, PREVIEW_WINDOW_MAX_WIDTH);
    let requested_height = preview_height
        .unwrap_or(0)
        .clamp(PREVIEW_WINDOW_MIN_HEIGHT, PREVIEW_WINDOW_MAX_HEIGHT);
    let width = if requested_width > 0 {
        (requested_width as f64 * scale_factor).round() as u32
    } else {
        (PREVIEW_WINDOW_DEFAULT_WIDTH as f64 * scale_factor).round() as u32
    };
    let height = if requested_height > 0 {
        (requested_height as f64 * scale_factor).round() as u32
    } else {
        (PREVIEW_WINDOW_DEFAULT_HEIGHT as f64 * scale_factor).round() as u32
    };

    let main_window_opt = if main_window_width > 0 && main_window_height > 0 {
        Some((main_window_x, main_window_y, main_window_width, main_window_height))
    } else {
        None
    };

    let rect = resolve_preview_window_rect(
        work_area_x,
        work_area_y,
        work_area_width,
        work_area_height,
        main_window_opt,
        cursor_x,
        cursor_y,
        width,
        height,
        scale_factor,
    );

    let preview_data = PreviewWindowData {
        mode,
        source,
        item_id,
        cursor_x,
        cursor_y,
        scale_factor,
        work_area_x,
        work_area_y,
        work_area_width,
        work_area_height,
        main_window_x,
        main_window_y,
        main_window_width,
        main_window_height,
        item_rect,
        request_id,
    };

    upsert_preview_data(preview_data.clone());

    if let Some(existing) = app.get_webview_window(PREVIEW_WINDOW_LABEL) {
        if let Err(e) = apply_preview_window_rect(&existing, rect) {
            return Err(e);
        }
        if let Err(e) = refresh_preview_window_always_on_top(&existing) {
            return Err(e);
        }
        if let Err(e) = existing.emit("preview-window-data-updated", &preview_data) {
            return Err(format!("推送预览窗口数据失败: {}", e));
        }
        // 直接显示窗口，避免依赖前端 reveal 往返导致窗口滞留隐藏态
        let _ = existing.show();
        return Ok(());
    }

    let app_for_create = app.clone();
    let preview_data_for_create = preview_data.clone();
    tauri::async_runtime::spawn(async move {
        // 先尝试创建窗口。若 warmup 已创建则直接复用。
        let window = match create_preview_window(&app_for_create, rect, scale_factor) {
            Ok(window) => window,
            Err(error) => {
                if error.contains("already exists") {
                    // warmup 已创建窗口，复用它
                    match app_for_create.get_webview_window(PREVIEW_WINDOW_LABEL) {
                        Some(existing) => existing,
                        None => {
                            eprintln!("预览窗口报告已存在但无法获取: {}", error);
                            return;
                        }
                    }
                } else {
                    eprintln!("创建预览窗口失败: {}", error);
                    return;
                }
            }
        };

        if PREVIEW_REQUEST_VERSION.load(Ordering::SeqCst) != request_id {
            return;
        }

        let _ = apply_preview_window_rect(&window, rect);
        let _ = window.emit("preview-window-data-updated", &preview_data_for_create);

        // 等待 WebView2 控制器初始化完成后再显示窗口，避免 wry 空指针崩溃。
        tokio::time::sleep(Duration::from_millis(500)).await;

        if PREVIEW_REQUEST_VERSION.load(Ordering::SeqCst) != request_id {
            return;
        }

        let _ = refresh_preview_window_always_on_top(&window);
        let _ = window.show();
    });

    Ok(())
}

#[tauri::command]
pub fn set_preview_pinned(pinned: bool) -> Result<(), String> {
    PREVIEW_PINNED.store(pinned, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn close_preview_window(app: AppHandle) -> Result<(), String> {
    PREVIEW_REQUEST_VERSION.fetch_add(1, Ordering::SeqCst);
    let request_id = PREVIEW_DATA
        .lock()
        .map_err(|_| "获取预览窗口状态失败".to_string())?
        .as_ref()
        .map(|data| data.request_id)
        .unwrap_or_default();

    if request_id == 0 {
        hide_preview_window_internal(&app);
        return Ok(());
    }

    if let Some(window) = app.get_webview_window(PREVIEW_WINDOW_LABEL) {
        window
            .emit("preview-window-will-hide", request_id)
            .map_err(|e| format!("发送预览窗口隐藏事件失败: {}", e))?;
    } else {
        hide_preview_window_internal(&app);
    }

    Ok(())
}

pub fn suppress_preview_for_main_window_hide(app: &AppHandle) {
    PREVIEW_SUPPRESSED.store(true, Ordering::SeqCst);
    PREVIEW_REQUEST_VERSION.fetch_add(1, Ordering::SeqCst);
    PREVIEW_DESTROY_TIMER_VERSION.fetch_add(1, Ordering::SeqCst);

    // 只隐藏而非销毁，保持 WebView2 控制器存活。
    hide_preview_window_internal(app);
    if let Ok(mut guard) = PREVIEW_DATA.lock() {
        *guard = None;
    }
    PREVIEW_PINNED.store(false, Ordering::SeqCst);

    let watchdog_version = PREVIEW_HIDE_WATCHDOG_VERSION.fetch_add(1, Ordering::SeqCst) + 1;
    schedule_preview_hide_watchdog(app.clone(), watchdog_version);
}

pub fn resume_preview_after_main_window_show() {
    PREVIEW_SUPPRESSED.store(false, Ordering::SeqCst);
    PREVIEW_HIDE_WATCHDOG_VERSION.fetch_add(1, Ordering::SeqCst);
}

/// 预热预览窗口：在后台异步创建 WebView 窗口但保持隐藏，
/// 使首次悬停时直接走窗口复用路径，避免 WebView2 冷启动延迟。
pub fn warmup_preview_window(app: &AppHandle) {
    if PREVIEW_SUPPRESSED.load(Ordering::SeqCst) {
        return;
    }

    // 窗口已存在则无需预热
    if app.get_webview_window(PREVIEW_WINDOW_LABEL).is_some() {
        return;
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // 获取主显示器信息用于创建窗口
        let monitor = match app.primary_monitor() {
            Ok(Some(m)) => m,
            Ok(None) | Err(_) => {
                eprintln!("预热预览窗口：获取主显示器信息失败");
                return;
            }
        };
        let work_area = monitor.work_area();
        let scale_factor = monitor.scale_factor();
        let work_area_x = work_area.position.x;
        let work_area_y = work_area.position.y;
        let work_area_width = work_area.size.width;
        let work_area_height = work_area.size.height;

        let mut last_error = None;
        let warmup_rect = (
            clamp_i32(
                work_area_x + 40,
                work_area_x,
                (work_area_x + work_area_width as i32)
                    .saturating_sub(PREVIEW_WINDOW_DEFAULT_WIDTH as i32)
                    .max(work_area_x),
            ),
            clamp_i32(
                work_area_y + 40,
                work_area_y,
                (work_area_y + work_area_height as i32)
                    .saturating_sub(PREVIEW_WINDOW_DEFAULT_HEIGHT as i32)
                    .max(work_area_y),
            ),
            PREVIEW_WINDOW_DEFAULT_WIDTH,
            PREVIEW_WINDOW_DEFAULT_HEIGHT,
        );
        for _ in 0..3 {
            match create_preview_window(
                &app,
                warmup_rect,
                scale_factor,
            ) {
                Ok(_window) => {
                    // 窗口创建成功，保持隐藏状态即可。
                    // 等待 WebView2 控制器初始化，避免后续 show 时触发 wry 空指针崩溃。
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    return;
                }
                Err(error) => {
                    if error.contains("already exists") {
                        // 窗口已存在（并发情况），无需继续
                        return;
                    }
                    last_error = Some(error);
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            }
        }

        if let Some(error) = last_error {
            eprintln!("预热预览窗口失败: {}", error);
        }
    });
}

pub fn force_close_preview_window(app: &AppHandle) {
    PREVIEW_REQUEST_VERSION.fetch_add(1, Ordering::SeqCst);
    PREVIEW_DESTROY_TIMER_VERSION.fetch_add(1, Ordering::SeqCst);
    // 只隐藏而非销毁，避免下次创建时 wry 空指针崩溃。
    hide_preview_window_internal(app);
    if let Ok(mut guard) = PREVIEW_DATA.lock() {
        *guard = None;
    }
    PREVIEW_PINNED.store(false, Ordering::SeqCst);
}

#[tauri::command]
pub fn reveal_preview_window(app: AppHandle, request_id: u64) -> Result<(), String> {
    let current_request_id = PREVIEW_DATA
        .lock()
        .map_err(|_| "获取预览窗口状态失败".to_string())?
        .as_ref()
        .map(|data| data.request_id)
        .unwrap_or_default();

    if current_request_id != request_id {
        return Ok(());
    }

    if let Some(window) = app.get_webview_window(PREVIEW_WINDOW_LABEL) {
        refresh_preview_window_always_on_top(&window)?;
        window
            .show()
            .map_err(|e| format!("显示预览窗口失败: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn finalize_hide_preview_window(app: AppHandle, request_id: u64) -> Result<(), String> {
    let current_request_id = PREVIEW_DATA
        .lock()
        .map_err(|_| "获取预览窗口状态失败".to_string())?
        .as_ref()
        .map(|data| data.request_id)
        .unwrap_or_default();

    if current_request_id != request_id {
        return Ok(());
    }

    hide_preview_window_internal(&app);
    let timer_version = PREVIEW_DESTROY_TIMER_VERSION.fetch_add(1, Ordering::SeqCst) + 1;
    schedule_preview_window_destroy(app, timer_version, request_id);
    Ok(())
}

#[tauri::command]
pub fn get_preview_window_data() -> Result<PreviewWindowData, String> {
    PREVIEW_DATA
        .lock()
        .map_err(|_| "获取预览窗口数据失败".to_string())?
        .clone()
        .ok_or_else(|| "预览窗口数据不存在".to_string())
}
