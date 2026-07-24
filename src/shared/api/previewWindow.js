import { invoke } from '@tauri-apps/api/core';
import { settingsStore } from '@shared/store/settingsStore';

function normalizePreviewAnchorRect(itemRect) {
  if (!itemRect || typeof itemRect !== 'object') {
    return null;
  }

  const left = Number(itemRect.left);
  const top = Number(itemRect.top);
  const width = Number(itemRect.width);
  const height = Number(itemRect.height);
  if (
    !Number.isFinite(left)
    || !Number.isFinite(top)
    || !Number.isFinite(width)
    || !Number.isFinite(height)
    || width <= 0
    || height <= 0
  ) {
    return null;
  }

  return { left, top, width, height };
}

function resolvePreviewSize() {
  const width = Number(settingsStore.previewWindowWidth);
  const height = Number(settingsStore.previewWindowHeight);
  return {
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : 640,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : 480,
  };
}

export async function showPreviewWindow(mode, source, itemId, itemRect = null) {
  const { width, height } = resolvePreviewSize();
  return await invoke('show_preview_window', {
    mode,
    source,
    itemId: String(itemId),
    itemRect: normalizePreviewAnchorRect(itemRect),
    previewWidth: width,
    previewHeight: height,
  });
}

export async function closePreviewWindow() {
  return await invoke('close_preview_window');
}

export async function setPreviewPinned(pinned) {
  return await invoke('set_preview_pinned', { pinned: Boolean(pinned) });
}
