import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PhysicalSize, PhysicalPosition } from '@tauri-apps/api/dpi';

const RESIZE_HANDLE_TRIGGER_SIZE = 16;
const RESIZE_HANDLE_SHOW_DELAY = 150;
const RESIZE_HANDLE_HIDE_DELAY = 160;
const RESIZE_HANDLE_COLOR = '#9ca3af';

// 主窗口尺寸约束，与 tauri.conf.json 及 Rust 端保持一致
const MIN_W = 150;
const MIN_H = 150;
const MAX_W = 2560;
const MAX_H = 1600;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// dir 用于四角缩放逻辑；cursor/className/path 用于视觉与命中区。
// alwaysActive：命中区是否始终可点击。
//   - nw/sw/se 角下方无交互按钮，设为始终可点，避免"快速按下时落到下层触发窗口拖动"的问题。
//   - ne（右上角）下方是标题栏的 pin / 更多 按钮，保持仅在悬停提示出现后可点，避免遮挡按钮。
const RESIZE_HANDLES = [
  {
    dir: 'nw',
    label: '左上角',
    cursor: 'nwse-resize',
    className: 'left-0 top-0',
    alwaysActive: true,
    path: 'M 22 2.5 H 13 A 10.5 10.5 0 0 0 2.5 13 V 22'
  },
  {
    dir: 'ne',
    label: '右上角',
    cursor: 'nesw-resize',
    className: 'right-0 top-0',
    alwaysActive: false,
    path: 'M 4 2.5 H 13 A 10.5 10.5 0 0 1 23.5 13 V 22'
  },
  {
    dir: 'sw',
    label: '左下角',
    cursor: 'nesw-resize',
    className: 'bottom-0 left-0',
    alwaysActive: true,
    path: 'M 2.5 4 V 13 A 10.5 10.5 0 0 0 13 23.5 H 22'
  },
  {
    dir: 'se',
    label: '右下角',
    cursor: 'nwse-resize',
    className: 'bottom-0 right-0',
    alwaysActive: true,
    path: 'M 23.5 4 V 13 A 10.5 10.5 0 0 1 13 23.5 H 4'
  }
];

function WindowResizeHandles() {
  const [isVisible, setIsVisible] = useState(false);
  const isResizingRef = useRef(false);
  const dragRef = useRef(null);
  const showTimerRef = useRef(null);
  const hideTimerRef = useRef(null);

  const clearShowTimer = () => {
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  };

  const clearHideTimer = () => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  const showWithDelay = () => {
    clearHideTimer();
    if (!isVisible && !showTimerRef.current) {
      showTimerRef.current = setTimeout(() => {
        showTimerRef.current = null;
        setIsVisible(true);
      }, RESIZE_HANDLE_SHOW_DELAY);
    }
  };

  const hideWithDelay = () => {
    clearShowTimer();
    if (isVisible && !hideTimerRef.current) {
      hideTimerRef.current = setTimeout(() => {
        hideTimerRef.current = null;
        setIsVisible(false);
      }, RESIZE_HANDLE_HIDE_DELAY);
    }
  };

  useEffect(() => {
    const handleMouseMove = event => {
      if (isResizingRef.current) {
        return;
      }

      const pointerX = event.clientX;
      const pointerY = event.clientY;
      const isNearReservedSpace =
        pointerX <= RESIZE_HANDLE_TRIGGER_SIZE ||
        pointerY <= RESIZE_HANDLE_TRIGGER_SIZE ||
        window.innerWidth - pointerX <= RESIZE_HANDLE_TRIGGER_SIZE ||
        window.innerHeight - pointerY <= RESIZE_HANDLE_TRIGGER_SIZE;

      if (isNearReservedSpace) {
        showWithDelay();
      } else {
        hideWithDelay();
      }
    };

    const handleMouseLeave = () => {
      if (!isResizingRef.current) {
        hideWithDelay();
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    document.documentElement.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      document.documentElement.removeEventListener('mouseleave', handleMouseLeave);
      clearShowTimer();
      clearHideTimer();
    };
  }, [isVisible]);

  // 无边框透明窗没有系统原生缩放边框，Tauri 的 startResizeDragging 在本项目下
  // 只有 NorthWest(左上) 能成功，其余方向静默失败。这里改用 setSize/setPosition +
  // 鼠标位移自行实现四角缩放，所有方向都可控。
  //
  // 关键：必须用 mousemove / mouseup（而非 pointermove / pointerup）。
  // 鼠标按住拖动时 pointermove 在指针移出窗口后不再触发，会导致缩放卡死；
  // 且 Resized 事件停止后，Rust 侧 edge_monitor 的 400ms 抑制过期，会把窗口吸附到
  // 屏幕边缘造成"跳走"。mousemove 有隐式捕获，移出窗口也持续触发，规避这两个问题。
  const handleMouseDown = async (event, handle) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const win = getCurrentWindow();
    let outer;
    let inner;
    let scale;
    try {
      [outer, inner, scale] = await Promise.all([
        win.outerPosition(),
        win.innerSize(),
        win.scaleFactor()
      ]);
    } catch (err) {
      console.error('获取主窗口尺寸失败:', err);
      return;
    }

    const dpr = scale && scale > 0 ? scale : window.devicePixelRatio || 1;
    dragRef.current = {
      dir: handle.dir,
      startLeft: outer.x, // 物理像素
      startTop: outer.y,
      startW: inner.width, // 物理像素
      startH: inner.height,
      scale: dpr,
      startScreenX: event.screenX, // 屏幕坐标，不受窗口移动影响
      startScreenY: event.screenY,
    };
    isResizingRef.current = true;
    setIsVisible(true);

    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';

    const onMove = e => {
      const s = dragRef.current;
      if (!s) {
        return;
      }
      // 兜底：万一 mouseup 没被捕到（例如指针在窗口外释放），buttons 归零即停止
      if (e.buttons === 0) {
        onUp();
        return;
      }

      // 用 screenX/screenY 计算从拖拽起点的累计偏移（物理像素）
      const dx = (e.screenX - s.startScreenX) * s.scale;
      const dy = (e.screenY - s.startScreenY) * s.scale;

      const newW = clamp(
        s.startW + (s.dir === 'nw' || s.dir === 'sw' ? -dx : dx),
        MIN_W,
        MAX_W
      );
      const newH = clamp(
        s.startH + (s.dir === 'nw' || s.dir === 'ne' ? -dy : dy),
        MIN_H,
        MAX_H
      );

      let newLeft = s.startLeft;
      let newTop = s.startTop;
      // 锚定不动的对角：nw 锚右下、ne 锚左下、sw 锚右上、se 锚左上
      if (s.dir === 'nw' || s.dir === 'sw') {
        newLeft = s.startLeft + (s.startW - newW);
      }
      if (s.dir === 'nw' || s.dir === 'ne') {
        newTop = s.startTop + (s.startH - newH);
      }

      try {
        win.setSize(new PhysicalSize(newW, newH));
        if (s.dir === 'nw' || s.dir === 'sw' || s.dir === 'ne') {
          win.setPosition(new PhysicalPosition(newLeft, newTop));
        }
      } catch (err) {
        console.error('调整主窗口大小失败:', err);
      }
    };

    const onUp = async () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = prevUserSelect;
      dragRef.current = null;
      isResizingRef.current = false;
      setIsVisible(false);

      // 拖拽结束立即持久化最终尺寸，避免落在 500ms 防抖窗口内而丢失最后一次缩放结果。
      try {
        const appWindow = getCurrentWindow();
        const size = await appWindow.innerSize();
        const sf = await appWindow.scaleFactor();
        const logicalWidth = Math.max(1, Math.round(size.width / Math.max(sf, 1)));
        const logicalHeight = Math.max(1, Math.round(size.height / Math.max(sf, 1)));
        const { saveWindowSize } = await import('@shared/api/settings');
        await saveWindowSize(logicalWidth, logicalHeight);
      } catch (err) {
        console.error('保存主窗口大小失败:', err);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <>
      {RESIZE_HANDLES.map(handle => {
        const active = isVisible || isResizingRef.current;
        const clickable = handle.alwaysActive || active;
        return (
          <div
            key={handle.dir}
            data-no-drag
            aria-label={`调整窗口大小：${handle.label}`}
            className={`absolute z-50 h-[18px] w-[18px] transition-opacity duration-200 ease-out ${clickable ? 'pointer-events-auto' : 'pointer-events-none'} ${active ? 'opacity-80' : 'opacity-0'} ${handle.className}`}
            style={{ cursor: handle.cursor }}
            onMouseDown={event => handleMouseDown(event, handle)}
          >
            <svg
              aria-hidden="true"
              className="pointer-events-none h-full w-full overflow-visible"
              data-no-drag
              viewBox="0 0 26 26"
            >
              <path
                d={handle.path}
                fill="none"
                stroke="transparent"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="5"
                style={{ pointerEvents: 'none' }}
              />
              <path
                d={handle.path}
                fill="none"
                stroke={RESIZE_HANDLE_COLOR}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="4"
                style={{
                  filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.25))',
                  pointerEvents: 'none'
                }}
              />
            </svg>
          </div>
        );
      })}
    </>
  );
}

export default WindowResizeHandles;
