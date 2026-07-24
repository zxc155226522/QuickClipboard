import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useSnapshot } from 'valtio';
import { defaultSettings } from '@shared/services/settingsService';
import { settingsStore, initSettings } from '@shared/store/settingsStore';
import { useTheme, applyThemeToBody } from '@shared/hooks/useTheme';
import { useSettingsSync } from '@shared/hooks/useSettingsSync';
import { useWindowDrag } from '@shared/hooks/useWindowDrag';
import {
  applyBackgroundImage,
  clearBackgroundImage,
} from '@shared/utils/backgroundManager';
import {
  getClipboardItemById,
  getFavoriteItemById,
  getClipboardItemPasteOptions,
} from '@shared/api';
import { getFavoriteItemPasteOptions } from '@shared/api/favorites';
import {
  extractFormatKinds,
  formatKindsToLabels,
  resolvePreviewModes as resolveFormatPreviewModes,
} from '@shared/utils/pasteFormatHints';
import { normalizeDisplayPriorityOrder } from '@shared/utils/displayFormatPriority';
import {
  ImagePreview,
  FilePreview,
  HtmlPreview,
  TextPreview,
} from './views';
import {
  MODE_TEXT,
  MODE_HTML,
  MODE_IMAGE,
  MODE_FILE,
  TEXT_SCROLL_STEP,
  IMAGE_SCALE_STEP,
  IMAGE_SCALE_MIN,
  IMAGE_SCALE_MAX,
  IMAGE_SCALE_INDICATOR_DURATION,
  IMAGE_STATUS_IDLE,
  IMAGE_STATUS_LOADING,
  IMAGE_STATUS_READY,
  IMAGE_STATUS_ERROR,
  clamp,
  isFiniteNumber,
  resolvePreviewMode,
  parsePreviewFiles,
  buildPreviewFileStats,
  parseImageFilePath,
  parseRawImagePath,
  parseFirstImageId,
  parseImageDimensionsFromItem,
} from './utils';
import { closePreviewWindow, setPreviewPinned } from '@shared/api/previewWindow';
import PreviewResizeHandles from './components/PreviewResizeHandles';

const IMAGE_FILE_EXTENSION_PATTERN = /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?|avif)$/i;

// 布局常量（逻辑像素）
const TOOLBAR_HEIGHT = 32;
const CONTENT_PADDING = 10;

function isLikelyImageFilePath(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) {
    return false;
  }

  const pathWithoutQuery = trimmed.split(/[?#]/)[0];
  const hasPathMarker =
    pathWithoutQuery.includes(':')
    || pathWithoutQuery.startsWith('\\\\')
    || pathWithoutQuery.includes('/')
    || pathWithoutQuery.includes('\\');

  return hasPathMarker && IMAGE_FILE_EXTENSION_PATTERN.test(pathWithoutQuery);
}

async function loadItemData(source, itemId) {
  if (source === 'clipboard') {
    const numericId = Number(itemId);
    if (!Number.isFinite(numericId)) {
      throw new Error('剪贴板项目 ID 无效');
    }
    return await getClipboardItemById(numericId);
  }

  if (source === 'favorite') {
    return await getFavoriteItemById(String(itemId));
  }

  throw new Error('未知预览来源');
}

async function loadPasteOptions(source, itemId) {
  if (source === 'clipboard') {
    const numericId = Number(itemId);
    if (!Number.isFinite(numericId)) {
      return [];
    }
    return await getClipboardItemPasteOptions(numericId);
  }

  if (source === 'favorite') {
    return await getFavoriteItemPasteOptions(String(itemId));
  }

  return [];
}

async function resolveImageUrlFromItem(item) {
  const content = typeof item?.content === 'string' ? item.content.trim() : '';
  if (content.startsWith('data:image/')) {
    return content;
  }

  const parsedPath = parseImageFilePath(content);
  if (parsedPath) {
    const resolvedPath = parsedPath.includes(':') || parsedPath.startsWith('\\\\')
      ? parsedPath
      : await invoke('resolve_image_path', { storedPath: parsedPath });
    return convertFileSrc(resolvedPath, 'asset');
  }

  const imageId = parseFirstImageId(item?.image_id);
  if (imageId) {
    const dataDir = await invoke('get_data_directory');
    const normalizedDataDir = String(dataDir).replace(/\\/g, '/');
    const filePath = `${normalizedDataDir}/clipboard_images/${imageId}.png`;
    return convertFileSrc(filePath, 'asset');
  }

  const rawPath = parseRawImagePath(content);
  if (isLikelyImageFilePath(rawPath)) {
    const resolvedPath = rawPath.includes(':') || rawPath.startsWith('\\\\')
      ? rawPath
      : await invoke('resolve_image_path', { storedPath: rawPath });
    return convertFileSrc(resolvedPath, 'asset');
  }

  if (rawPath.startsWith('image-id:')) {
    const legacyImageId = rawPath.slice('image-id:'.length).trim();
    const dataDir = await invoke('get_data_directory');
    const normalizedDataDir = String(dataDir).replace(/\\/g, '/');
    const filePath = `${normalizedDataDir}/clipboard_images/${legacyImageId}.png`;
    return convertFileSrc(filePath, 'asset');
  }

  return '';
}

function orderPreviewModesByDisplayPriority(modes, displayPriorityOrder) {
  if (!Array.isArray(modes) || modes.length <= 1) {
    return Array.isArray(modes) ? modes : [];
  }

  const orderedFormats = normalizeDisplayPriorityOrder(displayPriorityOrder);
  const modeOrderMap = {
    text: MODE_TEXT,
    html: MODE_HTML,
    image: MODE_IMAGE,
    file: MODE_FILE,
  };
  const orderedModes = orderedFormats
    .map((format) => modeOrderMap[format])
    .filter((mode) => typeof mode === 'string' && mode.length > 0);

  const weight = new Map(orderedModes.map((mode, index) => [mode, index]));
  const fallbackWeight = orderedModes.length + 10;
  return [...modes].sort((a, b) => {
    const wa = weight.has(a) ? weight.get(a) : fallbackWeight;
    const wb = weight.has(b) ? weight.get(b) : fallbackWeight;
    return wa - wb;
  });
}

function App() {
  const { t } = useTranslation();
  const [previewData, setPreviewData] = useState(null);
  const [previewMode, setPreviewMode] = useState(MODE_TEXT);
  const [previewItem, setPreviewItem] = useState(null);
  const [formatKinds, setFormatKinds] = useState([]);
  const [textContent, setTextContent] = useState('');
  const [htmlContent, setHtmlContent] = useState('');
  const [textHeightOverflow, setTextHeightOverflow] = useState(0);
  const [htmlMeasuredSize, setHtmlMeasuredSize] = useState(null);
  const [imageUrl, setImageUrl] = useState('');
  const [imageLoadState, setImageLoadState] = useState(IMAGE_STATUS_IDLE);
  const [imageDimensions, setImageDimensions] = useState(null);
  const [imageScale, setImageScale] = useState(1);
  const [imagePan, setImagePan] = useState({ x: 0, y: 0 });
  const [showImageScaleIndicator, setShowImageScaleIndicator] = useState(false);
  const [scrollability, setScrollability] = useState({
    text: false,
    html: false,
    file: false,
  });
  const [isVisible, setIsVisible] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [windowSize, setWindowSize] = useState({
    width: typeof window !== 'undefined' ? window.innerWidth : 640,
    height: typeof window !== 'undefined' ? window.innerHeight : 480,
  });
  const revealedRequestIdRef = useRef(0);
  const revealAnimationFrameRef = useRef(0);
  const textPreviewRef = useRef(null);
  const htmlPreviewRef = useRef(null);
  const filePreviewRef = useRef(null);
  const imageScaleIndicatorTimerRef = useRef(null);
  const imageStageRef = useRef(null);
  const imageDragRef = useRef({ active: false, lastX: 0, lastY: 0 });
  const panStateRef = useRef({ x: 0, y: 0 });
  const settings = useSnapshot(settingsStore);
  const { theme, lightThemeStyle, darkThemeStyle, backgroundImagePath } = settings;
  const { effectiveTheme, isDark, isBackground } = useTheme();
  useSettingsSync();

  // 顶部工具栏作为可拖拽区(标题栏),移动整个预览窗口。
  // pin / ✕ 是 <button>,已在排除列表内,点击它们不会触发拖动。
  const toolbarDragRef = useWindowDrag({
    excludeSelectors: ['button', '[data-no-drag]', 'input', 'textarea'],
    allowChildren: true,
  });

  // 监听窗口尺寸变化：拖拽改大小后同步布局，并持久化到设置（主窗下次悬停沿用）
  useEffect(() => {
    let saveTimer = null;
    const unlistenPromise = getCurrentWindow().listen('resize', () => {
      const nextWidth = Math.round(window.innerWidth);
      const nextHeight = Math.round(window.innerHeight);
      setWindowSize({ width: nextWidth, height: nextHeight });
      if (
        nextWidth === settingsStore.previewWindowWidth
        && nextHeight === settingsStore.previewWindowHeight
      ) {
        return;
      }
      if (saveTimer) {
        clearTimeout(saveTimer);
      }
      saveTimer = setTimeout(() => {
        settingsStore.saveSettings({
          previewWindowWidth: nextWidth,
          previewWindowHeight: nextHeight,
        }, { showToast: false }).catch(() => { });
      }, 250);
    });
    return () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
      }
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const resetPreviewState = () => {
    revealedRequestIdRef.current = 0;
    setPreviewData(null);
    setPreviewItem(null);
    setFormatKinds([]);
    setPreviewMode(MODE_TEXT);
    setTextContent('');
    setHtmlContent('');
    setTextHeightOverflow(0);
    setHtmlMeasuredSize(null);
    setImageUrl('');
    setImageLoadState(IMAGE_STATUS_IDLE);
    setImageDimensions(null);
    setImageScale(1);
    setImagePan({ x: 0, y: 0 });
    panStateRef.current = { x: 0, y: 0 };
    setShowImageScaleIndicator(false);
    setScrollability({
      text: false,
      html: false,
      file: false,
    });
    setPinned(false);
    setIsVisible(false);
    if (revealAnimationFrameRef.current) {
      cancelAnimationFrame(revealAnimationFrameRef.current);
      revealAnimationFrameRef.current = 0;
    }
  };

  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const oldHtmlOverflow = html.style.overflow;
    const oldBodyOverflow = body.style.overflow;
    const oldBodyMargin = body.style.margin;
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    body.style.margin = '0';
    return () => {
      html.style.overflow = oldHtmlOverflow;
      body.style.overflow = oldBodyOverflow;
      body.style.margin = oldBodyMargin;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    initSettings().catch(() => { });
    invoke('get_preview_window_data')
      .then((data) => {
        if (!mounted) return;
        setPreviewData(data);
        revealedRequestIdRef.current = 0;
        setIsVisible(true);
      })
      .catch((error) => {
        console.error('获取预览窗口数据失败:', error);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const applyPreviewData = (data) => {
      // 已固定时保持当前内容，忽略新的预览请求
      if (pinned) {
        return;
      }
      setPreviewData(data);
      revealedRequestIdRef.current = 0;
      // 拿到数据立即显示卡片，避免依赖 reveal 往返导致不可见
      setIsVisible(true);
    };

    const unlistenPromise = listen('preview-window-data-updated', (event) => {
      applyPreviewData(event.payload);
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => { });
    };
  }, [pinned]);

  useEffect(() => {
    const unlistenPromise = listen('preview-window-will-hide', (event) => {
      const requestId = Number(event.payload);
      if (!Number.isFinite(requestId) || requestId <= 0) {
        return;
      }
      if (previewData?.request_id && Number(previewData.request_id) !== requestId) {
        return;
      }

      flushSync(() => {
        resetPreviewState();
      });

      requestAnimationFrame(() => {
        invoke('finalize_hide_preview_window', { requestId }).catch((error) => {
          console.error('完成预览窗口隐藏失败:', error);
        });
      });
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => { });
    };
  }, [previewData]);

  useEffect(() => {
    applyThemeToBody(theme || defaultSettings.theme, 'preview');
  }, [theme, lightThemeStyle, darkThemeStyle, effectiveTheme]);

  useEffect(() => {
    if (isBackground && backgroundImagePath) {
      applyBackgroundImage({
        containerSelector: '.preview-theme-anchor',
        backgroundImagePath,
        windowName: 'preview',
      });
    } else {
      clearBackgroundImage('.preview-theme-anchor');
    }
    return () => {
      clearBackgroundImage('.preview-theme-anchor');
    };
  }, [isBackground, backgroundImagePath]);

  useEffect(() => {
    if (!previewData) return;
    let cancelled = false;

    setPreviewItem(null);
    setFormatKinds([]);
    setPreviewMode(
      previewData.mode === MODE_IMAGE
        ? MODE_IMAGE
        : previewData.mode === MODE_FILE
          ? MODE_FILE
        : previewData.mode === MODE_HTML
          ? MODE_HTML
          : MODE_TEXT,
    );
    setTextContent('');
    setHtmlContent('');
    setTextHeightOverflow(0);
    setHtmlMeasuredSize(null);
    setImageUrl('');
    setImageLoadState(IMAGE_STATUS_IDLE);
    setImageDimensions(null);
    setImageScale(1);
    setImagePan({ x: 0, y: 0 });
    panStateRef.current = { x: 0, y: 0 };
    setShowImageScaleIndicator(false);

    const run = async () => {
      try {
        const [item, pasteOptions] = await Promise.all([
          loadItemData(previewData.source, previewData.item_id),
          loadPasteOptions(previewData.source, previewData.item_id).catch(() => []),
        ]);
        if (cancelled) return;

        const nextFormatKinds = extractFormatKinds(pasteOptions, item);
        const supportedPreviewModes = orderPreviewModesByDisplayPriority(
          resolveFormatPreviewModes(item, nextFormatKinds),
          settings.displayPriorityOrder,
        );
        const requestedMode = resolvePreviewMode(previewData.mode, item);
        const initialMode = supportedPreviewModes.includes(requestedMode)
          ? requestedMode
          : (supportedPreviewModes[0] || MODE_TEXT);

        setPreviewItem(item);
        setFormatKinds(nextFormatKinds);
        setPreviewMode(initialMode);
        setTextContent(item?.content || '');
        setTextHeightOverflow(0);
        setHtmlMeasuredSize(null);
        setHtmlContent(item?.html_content || '');
      } catch (error) {
        console.error('加载预览内容失败:', error);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [previewData, settings.displayPriorityOrder]);

  const currentRequestId = useMemo(() => {
    const requestId = Number(previewData?.request_id);
    return Number.isFinite(requestId) ? requestId : 0;
  }, [previewData?.request_id]);

  useEffect(() => {
    if (!previewItem || previewMode !== MODE_IMAGE) {
      setImageUrl('');
      setImageLoadState(IMAGE_STATUS_IDLE);
      setImageDimensions(null);
      setImageScale(1);
      setImagePan({ x: 0, y: 0 });
      panStateRef.current = { x: 0, y: 0 };
      return;
    }

    let cancelled = false;
    setImageLoadState(IMAGE_STATUS_LOADING);
    setImageUrl('');
    setImageDimensions(parseImageDimensionsFromItem(previewItem));
    setImageScale(1);
    setImagePan({ x: 0, y: 0 });
    panStateRef.current = { x: 0, y: 0 };

    resolveImageUrlFromItem(previewItem)
      .then((url) => {
        if (cancelled) return;
        if (!url) {
          console.warn('图片预览未解析到可用地址:', {
            source: previewData?.source,
            itemId: previewData?.item_id,
            contentType: previewItem?.content_type,
            imageId: previewItem?.image_id,
          });
          setImageLoadState(IMAGE_STATUS_ERROR);
          setImageDimensions(null);
          return;
        }
        setImageUrl(url);
        setImageLoadState(IMAGE_STATUS_LOADING);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('加载图片预览失败:', error);
        setImageLoadState(IMAGE_STATUS_ERROR);
      });

    return () => {
      cancelled = true;
    };
  }, [previewItem, previewMode, previewData]);

  const previewReady = useMemo(() => {
    if (!previewData || !previewItem) {
      return false;
    }

    if (previewMode === MODE_IMAGE) {
      return imageLoadState === IMAGE_STATUS_READY || imageLoadState === IMAGE_STATUS_ERROR;
    }

    return true;
  }, [previewData, previewItem, previewMode, imageLoadState]);

  useEffect(() => {
    if (!previewReady || currentRequestId <= 0) {
      return;
    }
    if (revealedRequestIdRef.current === currentRequestId) {
      return;
    }

    let cancelled = false;
    const rafId = requestAnimationFrame(() => {
      if (cancelled) {
        return;
      }
      invoke('reveal_preview_window', { requestId: currentRequestId })
        .then(() => {
          if (!cancelled) {
            revealedRequestIdRef.current = currentRequestId;
            if (revealAnimationFrameRef.current) {
              cancelAnimationFrame(revealAnimationFrameRef.current);
            }
            revealAnimationFrameRef.current = requestAnimationFrame(() => {
              revealAnimationFrameRef.current = 0;
              if (!cancelled) {
                setIsVisible(true);
              }
            });
          }
        })
        .catch((error) => {
          console.error('显示预览窗口失败:', error);
        });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (revealAnimationFrameRef.current) {
        cancelAnimationFrame(revealAnimationFrameRef.current);
        revealAnimationFrameRef.current = 0;
      }
    };
  }, [currentRequestId, previewReady]);

  useEffect(() => {
    return () => {
      if (imageScaleIndicatorTimerRef.current) {
        clearTimeout(imageScaleIndicatorTimerRef.current);
        imageScaleIndicatorTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (previewMode === MODE_IMAGE) {
      return;
    }

    setShowImageScaleIndicator(false);
    if (imageScaleIndicatorTimerRef.current) {
      clearTimeout(imageScaleIndicatorTimerRef.current);
      imageScaleIndicatorTimerRef.current = null;
    }
  }, [previewMode]);

  useEffect(() => {
    setScrollability({
      text: false,
      html: false,
      file: false,
    });
  }, [currentRequestId, previewMode, previewItem?.id, previewItem?.item_id, previewItem?.favorite_id]);

  const showImageScaleIndicatorTemporarily = useCallback(() => {
    setShowImageScaleIndicator(true);
    if (imageScaleIndicatorTimerRef.current) {
      clearTimeout(imageScaleIndicatorTimerRef.current);
    }
    imageScaleIndicatorTimerRef.current = setTimeout(() => {
      setShowImageScaleIndicator(false);
      imageScaleIndicatorTimerRef.current = null;
    }, IMAGE_SCALE_INDICATOR_DURATION);
  }, []);

  useEffect(() => {
    const handleResize = () => {
      setWindowSize({
        width: typeof window !== 'undefined' ? window.innerWidth : 640,
        height: typeof window !== 'undefined' ? window.innerHeight : 480,
      });
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  // Esc 关闭预览
  useEffect(() => {
    if (!previewData) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleClosePreview();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewData]);

  const handleClosePreview = useCallback(() => {
    setPinned(false);
    setPreviewPinned(false).catch(() => { });
    closePreviewWindow().catch(() => { });
  }, []);

  const togglePin = useCallback(() => {
    setPinned((prev) => {
      const next = !prev;
      setPreviewPinned(next).catch(() => { });
      return next;
    });
  }, []);

  // 图片缩放（直接滚轮），使用非被动监听以便 preventDefault
  const handleImageWheel = useCallback((event) => {
    event.preventDefault();
    const delta = event.deltaY < 0 ? IMAGE_SCALE_STEP : -IMAGE_SCALE_STEP;
    setImageScale((prev) => {
      const next = clamp(Number((prev + delta).toFixed(2)), IMAGE_SCALE_MIN, IMAGE_SCALE_MAX);
      if (next === IMAGE_SCALE_MIN) {
        panStateRef.current = { x: 0, y: 0 };
        setImagePan({ x: 0, y: 0 });
      }
      if (next !== prev) {
        showImageScaleIndicatorTemporarily();
      }
      return next;
    });
  }, [showImageScaleIndicatorTemporarily]);

  useEffect(() => {
    const stage = imageStageRef.current;
    if (!stage) return undefined;
    const listener = (event) => handleImageWheel(event);
    stage.addEventListener('wheel', listener, { passive: false });
    return () => {
      stage.removeEventListener('wheel', listener);
    };
  }, [handleImageWheel, previewMode]);

  const handleImagePointerDown = useCallback((event) => {
    if (imageScale <= IMAGE_SCALE_MIN + 0.001) {
      return;
    }
    imageDragRef.current = { active: true, lastX: event.clientX, lastY: event.clientY };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  }, [imageScale]);

  const handleImagePointerMove = useCallback((event) => {
    const drag = imageDragRef.current;
    if (!drag.active) {
      return;
    }
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    panStateRef.current = {
      x: panStateRef.current.x + dx,
      y: panStateRef.current.y + dy,
    };
    setImagePan({ ...panStateRef.current });
  }, []);

  const handleImagePointerUp = useCallback(() => {
    imageDragRef.current.active = false;
  }, []);

  useEffect(() => {
    if (!previewData) return;

    const unlistenPromise = listen('preview-window-scroll', (event) => {
      const payload = event.payload || {};
      if (
        payload.itemId !== previewData.item_id ||
        payload.source !== previewData.source ||
        payload.mode !== previewData.mode
      ) {
        return;
      }

      const direction = payload.direction === 'up' ? 'up' : 'down';
      if (previewMode === MODE_TEXT) {
        const delta = direction === 'up' ? -TEXT_SCROLL_STEP : TEXT_SCROLL_STEP;
        textPreviewRef.current?.scrollBy(delta);
        return;
      }

      if (previewMode === MODE_HTML) {
        const delta = direction === 'up' ? -TEXT_SCROLL_STEP : TEXT_SCROLL_STEP;
        htmlPreviewRef.current?.scrollBy(delta);
        return;
      }

      if (previewMode === MODE_FILE) {
        const delta = direction === 'up' ? -TEXT_SCROLL_STEP : TEXT_SCROLL_STEP;
        filePreviewRef.current?.scrollBy(delta);
        return;
      }

      if (previewMode === MODE_IMAGE) {
        setImageScale((prev) => {
          const next = direction === 'up' ? prev + IMAGE_SCALE_STEP : prev - IMAGE_SCALE_STEP;
          const clampedScale = clamp(Number(next.toFixed(2)), IMAGE_SCALE_MIN, IMAGE_SCALE_MAX);
          if (clampedScale !== prev) {
            showImageScaleIndicatorTemporarily();
          }
          return clampedScale;
        });
      }
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => { });
    };
  }, [previewData, previewMode]);

  const supportedPreviewModes = useMemo(
    () => orderPreviewModesByDisplayPriority(
      resolveFormatPreviewModes(previewItem, formatKinds).filter((mode) => (
        mode !== MODE_FILE || settings.filePreview !== false
      )),
      settings.displayPriorityOrder,
    ),
    [previewItem, formatKinds, settings.displayPriorityOrder, settings.filePreview],
  );

  const filePreviewFiles = useMemo(
    () => parsePreviewFiles(previewItem),
    [previewItem],
  );

  const filePreviewStats = useMemo(
    () => buildPreviewFileStats(filePreviewFiles),
    [filePreviewFiles],
  );

  useEffect(() => {
    if (!supportedPreviewModes.length) {
      return;
    }
    if (!supportedPreviewModes.includes(previewMode)) {
      setPreviewMode(supportedPreviewModes[0]);
    }
  }, [supportedPreviewModes, previewMode]);

  useEffect(() => {
    if (!previewData) {
      return;
    }

    const unlistenPromise = listen('preview-window-cycle-format', (event) => {
      const payload = event.payload || {};
      if (
        payload.itemId !== previewData.item_id ||
        payload.source !== previewData.source
      ) {
        return;
      }

      if (supportedPreviewModes.length <= 1) {
        return;
      }

      const direction = payload.direction === 'prev' ? 'prev' : 'next';
      setPreviewMode((currentMode) => {
        const currentIndex = supportedPreviewModes.indexOf(currentMode);
        const safeIndex = currentIndex >= 0 ? currentIndex : 0;
        const nextIndex = direction === 'prev'
          ? (safeIndex - 1 + supportedPreviewModes.length) % supportedPreviewModes.length
          : (safeIndex + 1) % supportedPreviewModes.length;
        const nextMode = supportedPreviewModes[nextIndex];
        return nextMode;
      });
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => { });
    };
  }, [previewData, supportedPreviewModes]);

  const winW = windowSize.width;
  const winH = windowSize.height;
  const contentWidth = Math.max(120, winW - CONTENT_PADDING * 2);
  const contentHeight = Math.max(80, winH - TOOLBAR_HEIGHT - CONTENT_PADDING * 2);

  const imageScalePercent = useMemo(() => `${Math.round(imageScale * 100)}%`, [imageScale]);
  const previewModeLabel = useMemo(() => {
    if (previewMode === MODE_IMAGE) {
      return t('previewWindow.formatImage', '图片');
    }
    if (previewMode === MODE_FILE) {
      return t('previewWindow.formatFile', '文件');
    }
    if (previewMode === MODE_HTML) {
      return t('previewWindow.formatHtml', 'HTML');
    }
    return t('previewWindow.formatText', '纯文本');
  }, [previewMode, t]);
  const formatHintLabels = useMemo(() => formatKindsToLabels(formatKinds, t), [formatKinds, t]);
  const formatHintText = useMemo(() => formatHintLabels.join(' / '), [formatHintLabels]);
  const textContainerBackgroundColor = useMemo(() => {
    if (isBackground) {
      return 'color-mix(in srgb, var(--qc-panel) 58%, transparent)';
    }
    return 'color-mix(in srgb, var(--qc-surface) 90%, transparent)';
  }, [isBackground]);
  const textContainerBackgroundImageStyle = useMemo(() => {
    if (!isBackground || !backgroundImagePath) {
      return undefined;
    }

    try {
      const assetUrl = convertFileSrc(backgroundImagePath, 'asset');
      return {
        backgroundImage: `url("${assetUrl}")`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
      };
    } catch {
      return undefined;
    }
  }, [isBackground, backgroundImagePath]);
  const blurredBackgroundLayerStyle = useMemo(() => {
    if (!textContainerBackgroundImageStyle) {
      return undefined;
    }

    return {
      ...textContainerBackgroundImageStyle,
      position: 'absolute',
      inset: '-12px',
      filter: 'blur(var(--theme-superbg-blur-10, 10px))',
      transform: 'scale(1.06)',
      transformOrigin: 'center',
      opacity: 0.92,
      pointerEvents: 'none',
    };
  }, [textContainerBackgroundImageStyle]);

  const previewEntranceStyle = useMemo(() => ({
    opacity: isVisible ? 1 : 0,
    transform: isVisible ? 'scale(1, 1)' : 'scale(0.96, 0.96)',
    transformOrigin: 'center center',
    transition: [
      'transform 160ms cubic-bezier(0.22, 1, 0.36, 1)',
      'opacity 130ms ease-out',
    ].join(', '),
    willChange: 'transform, opacity',
  }), [isVisible]);

  if (!previewData) {
    return (
      <div className="preview-container fixed inset-0 overflow-hidden bg-transparent">
        <div
          className="preview-theme-anchor pointer-events-none absolute opacity-0"
          style={{ width: 0, height: 0, overflow: 'hidden' }}
        />
      </div>
    );
  }

  return (
    <div className={`preview-container fixed inset-0 overflow-hidden bg-transparent ${isDark ? 'dark' : ''}`}>
      <div
        className="preview-theme-anchor pointer-events-none absolute opacity-0"
        style={{ width: 0, height: 0, overflow: 'hidden' }}
      />
      <div
        className="preview-card absolute"
        style={{
          inset: 0,
          borderRadius: '12px',
          border: '1px solid color-mix(in srgb, var(--qc-fg) 28%, transparent)',
          boxShadow: '0 8px 28px rgba(0, 0, 0, 0.30), 0 0 0 1px rgba(0, 0, 0, 0.04)',
          backgroundColor: textContainerBackgroundColor,
          overflow: 'hidden',
          ...previewEntranceStyle,
        }}
      >
        {blurredBackgroundLayerStyle && <div style={blurredBackgroundLayerStyle} />}

        {/* 顶部信息 + 工具栏 */}
        <div
          ref={toolbarDragRef}
          className="absolute left-0 right-0 flex items-center justify-between select-none"
          style={{ top: 0, height: TOOLBAR_HEIGHT, padding: '0 10px', zIndex: 30, cursor: 'move' }}
        >
          <div
            className="truncate text-[11px] font-medium"
            style={{ color: 'var(--qc-fg-muted)' }}
          >
            {previewModeLabel}
            {formatHintText ? ` · ${formatHintText}` : ''}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={togglePin}
              aria-label={pinned ? t('previewWindow.pinned', '已固定') : t('previewWindow.pin', '固定')}
              title={pinned ? t('previewWindow.pinned', '已固定') : t('previewWindow.pin', '固定')}
              className={`w-7 h-7 flex items-center justify-center rounded-lg transition-all duration-200 ${
                pinned
                  ? 'bg-[var(--qc-accent)] text-[var(--qc-accent-fg)]'
                  : 'hover:bg-qc-hover text-qc-fg-muted'
              }`}
            >
              <i className="ti ti-pin" style={{ fontSize: 16 }} data-stroke="1.5"></i>
            </button>
            <button
              type="button"
              onClick={handleClosePreview}
              aria-label={t('previewWindow.close', '关闭预览')}
              title={t('previewWindow.close', '关闭预览')}
              className="w-7 h-7 flex items-center justify-center rounded-lg transition-all duration-200 hover:bg-qc-hover text-qc-fg-muted"
            >
              <i className="ti ti-x" style={{ fontSize: 16 }} data-stroke="1.5"></i>
            </button>
          </div>
        </div>
        <PreviewResizeHandles />

        {/* 内容区 */}
        <div
          className="absolute"
          style={{
            top: TOOLBAR_HEIGHT,
            left: CONTENT_PADDING,
            right: CONTENT_PADDING,
            bottom: CONTENT_PADDING,
            overflow: 'hidden',
          }}
        >
          {(previewMode === MODE_TEXT || previewMode === MODE_HTML) && (
            <div
              className="preview-surface preview-text-surface relative z-10 w-full h-full border border-qc-border-strong overflow-hidden"
              style={{
                borderRadius: '8px',
                boxSizing: 'border-box',
                backgroundColor: textContainerBackgroundColor,
                boxShadow: '0 0 5px 1px rgba(0, 0, 0, 0.2)',
              }}
            >
              {blurredBackgroundLayerStyle && <div style={blurredBackgroundLayerStyle} />}
              <div className="relative z-10 w-full h-full overflow-hidden">
                {previewMode === MODE_HTML ? (
                  <HtmlPreview
                    key={currentRequestId}
                    ref={htmlPreviewRef}
                    htmlContent={htmlContent}
                    maxWidth={contentWidth}
                    maxHeight={contentHeight}
                    onPreferredSizeChange={(nextSize) => {
                      const nextWidth = Number(nextSize?.width);
                      const nextHeight = Number(nextSize?.height);
                      if (
                        !isFiniteNumber(nextWidth)
                        || !isFiniteNumber(nextHeight)
                        || nextWidth <= 0
                        || nextHeight <= 0
                      ) {
                        return;
                      }
                      setHtmlMeasuredSize((current) => (
                        current?.width === nextWidth && current?.height === nextHeight
                          ? current
                          : { width: nextWidth, height: nextHeight }
                      ));
                    }}
                    onScrollabilityChange={(nextValue) => {
                      setScrollability((current) => (current.html === nextValue
                        ? current
                        : { ...current, html: nextValue }));
                    }}
                  />
                ) : (
                  <TextPreview
                    ref={textPreviewRef}
                    content={textContent}
                    isDark={isDark}
                    isBackground={isBackground}
                    onHeightOverflowChange={(nextOverflow) => {
                      const overflow = Number(nextOverflow);
                      if (!isFiniteNumber(overflow) || overflow < 0) {
                        return;
                      }
                      setTextHeightOverflow((current) => Math.max(current, overflow));
                    }}
                    onScrollabilityChange={(nextValue) => {
                      setScrollability((current) => (current.text === nextValue
                        ? current
                        : { ...current, text: nextValue }));
                    }}
                  />
                )}
              </div>
            </div>
          )}

          {previewMode === MODE_FILE && (
            <div
              className="preview-surface preview-file-surface relative z-10 w-full h-full border border-qc-border-strong overflow-hidden"
              style={{
                borderRadius: '8px',
                backgroundColor: textContainerBackgroundColor,
                boxShadow: '0 0 5px 1px rgba(0, 0, 0, 0.2)',
              }}
            >
              {blurredBackgroundLayerStyle && <div style={blurredBackgroundLayerStyle} />}
              <div className="relative z-10 w-full h-full overflow-hidden">
                <FilePreview
                  ref={filePreviewRef}
                  files={filePreviewFiles}
                  stats={filePreviewStats}
                  t={t}
                  onScrollabilityChange={(nextValue) => {
                    setScrollability((current) => (current.file === nextValue
                      ? current
                      : { ...current, file: nextValue }));
                  }}
                />
              </div>
            </div>
          )}

          {previewMode === MODE_IMAGE && (
            <div
              ref={imageStageRef}
              className="relative z-10 w-full h-full overflow-hidden select-none"
              style={{
                borderRadius: '8px',
                cursor: imageScale > IMAGE_SCALE_MIN + 0.001 ? 'grab' : 'default',
                backgroundColor: 'rgba(0,0,0,0.02)',
                boxShadow: '0 0 5px 1px rgba(0, 0, 0, 0.2)',
                border: '1px solid var(--qc-border-strong)',
              }}
              onPointerDown={handleImagePointerDown}
              onPointerMove={handleImagePointerMove}
              onPointerUp={handleImagePointerUp}
              onPointerLeave={handleImagePointerUp}
            >
              <div
                className="absolute left-1/2 top-1/2"
                style={{
                  width: `${contentWidth}px`,
                  height: `${contentHeight}px`,
                  marginLeft: `${-contentWidth / 2}px`,
                  marginTop: `${-contentHeight / 2}px`,
                  transform: `translate(${imagePan.x}px, ${imagePan.y}px) scale(${imageScale})`,
                  transformOrigin: 'center center',
                }}
              >
                <ImagePreview
                  imageUrl={imageUrl}
                  imageLoadState={imageLoadState}
                  onLoad={(event) => {
                    const { naturalWidth, naturalHeight } = event.currentTarget;
                    if (naturalWidth > 0 && naturalHeight > 0) {
                      setImageDimensions({ width: naturalWidth, height: naturalHeight });
                    }
                    setImageLoadState(IMAGE_STATUS_READY);
                  }}
                  onError={() => {
                    setImageLoadState(IMAGE_STATUS_ERROR);
                  }}
                />
              </div>

              {showImageScaleIndicator && (
                <div
                  className="absolute"
                  style={{
                    right: 10,
                    bottom: 10,
                    padding: '2px 8px',
                    borderRadius: '999px',
                    fontSize: '12px',
                    fontWeight: 700,
                    color: '#fff',
                    background: 'rgba(0,0,0,0.55)',
                    zIndex: 40,
                  }}
                >
                  {imageScalePercent}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
