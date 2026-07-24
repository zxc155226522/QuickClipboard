import { useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PhysicalSize, PhysicalPosition } from '@tauri-apps/api/dpi';
import { settingsStore } from '@shared/store/settingsStore';

// 与设置面板中预览窗尺寸范围保持一致
const MIN_W = 240;
const MAX_W = 1920;
const MIN_H = 200;
const MAX_H = 1200;
const HANDLE = 16; // 角部命中区边长(px)

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const CORNERS = {
  nw: { cursor: 'nwse-resize', className: 'left-0 top-0' },
  ne: { cursor: 'nesw-resize', className: 'right-0 top-0' },
  sw: { cursor: 'nesw-resize', className: 'bottom-0 left-0' },
  se: { cursor: 'nwse-resize', className: 'bottom-0 right-0' },
};

// 无边框透明窗没有系统原生缩放边框，Tauri 的 startResizeDragging 在本项目下
// 只有 NorthWest(左上) 能成功，其余方向静默失败。这里改用 setSize/setPosition +
// 鼠标位移自行实现四角缩放，所有方向都可控。
//
// 关键：必须用 mousemove / mouseup（而非 pointermove / pointerup）。
// 鼠标按住拖动时 pointermove 在指针移出窗口后不再触发，会导致缩放卡死。
// mousemove 有隐式捕获，移出窗口也持续触发，规避此问题。
export default function PreviewResizeHandles() {
  const [active, setActive] = useState(null);
  const dragRef = useRef(null);

  const onMouseDown = async (event, dir) => {
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
        win.scaleFactor(),
      ]);
    } catch (err) {
      console.error('获取预览窗口尺寸失败:', err);
      return;
    }

    const dpr = scale && scale > 0 ? scale : window.devicePixelRatio || 1;
    dragRef.current = {
      dir,
      startLeft: outer.x, // 物理像素
      startTop: outer.y,
      startW: inner.width, // 物理像素
      startH: inner.height,
      scale: dpr,
    };
    setActive(dir);

    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';

    const onMove = (e) => {
      const s = dragRef.current;
      if (!s) {
        return;
      }
      // 兜底：万一 mouseup 没被捕到（例如指针在窗口外释放），buttons 归零即停止
      if (e.buttons === 0) {
        onUp();
        return;
      }

      const dx = e.movementX * s.scale;
      const dy = e.movementY * s.scale;

      const newW = clamp(
        s.startW + (s.dir === 'nw' || s.dir === 'sw' ? -dx : dx),
        MIN_W,
        MAX_W,
      );
      const newH = clamp(
        s.startH + (s.dir === 'nw' || s.dir === 'ne' ? -dy : dy),
        MIN_H,
        MAX_H,
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
        console.error('调整预览窗口大小失败:', err);
      }
    };

    const onUp = async () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = prevUserSelect;
      dragRef.current = null;
      setActive(null);

      // 拖拽结束立即持久化最终尺寸，避免依赖 resize 事件防抖丢失最后一次缩放结果。
      try {
        const size = await win.innerSize();
        const sf = await win.scaleFactor();
        const logicalWidth = Math.max(1, Math.round(size.width / Math.max(sf, 1)));
        const logicalHeight = Math.max(1, Math.round(size.height / Math.max(sf, 1)));
        settingsStore.saveSettings({
          previewWindowWidth: logicalWidth,
          previewWindowHeight: logicalHeight,
        }).catch(() => {});
      } catch (err) {
        console.error('保存预览窗口大小失败:', err);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <>
      {Object.entries(CORNERS).map(([dir, cfg]) => (
        <div
          key={dir}
          data-no-drag
          aria-label={`调整预览窗口大小：${dir.toUpperCase()}`}
          onMouseDown={(e) => onMouseDown(e, dir)}
          className={`absolute z-50 transition-colors duration-150 ${cfg.className} ${
            active === dir
              ? 'bg-[color-mix(in_srgb,var(--qc-accent)_30%,transparent)]'
              : 'hover:bg-[color-mix(in_srgb,var(--qc-fg)_14%,transparent)]'
          }`}
          style={{ width: HANDLE, height: HANDLE, cursor: cfg.cursor, touchAction: 'none' }}
        />
      ))}
    </>
  );
}
