import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { useSnapshot } from 'valtio';
import { settingsStore } from '@shared/store/settingsStore';
import { useTranslation } from 'react-i18next';
import { highlightText } from '@shared/utils/highlightText';
import { formatFileSize } from '@shared/utils/format';
import React from 'react';

const IMAGE_FILE_EXTENSIONS = ['PNG', 'JPG', 'JPEG', 'GIF', 'BMP', 'WEBP', 'ICO', 'SVG', 'TIF', 'TIFF'];

// 异步缩略图组件：按需加载，不阻塞渲染
function AsyncFileIcon({ file, size = 20 }) {
  const isImageFile = IMAGE_FILE_EXTENSIONS.includes(file.file_type?.toUpperCase());
  const previewPath = file.actual_path || file.path;
  const fileExists = file.exists !== false;
  const [thumbPath, setThumbPath] = React.useState(file.thumbnail_path || null);
  const [loading, setLoading] = React.useState(false);
  const requestedRef = React.useRef(false);

  // 文件不存在：直接显示提示
  if (!fileExists) {
    return (
      <div 
        className="flex-shrink-0 rounded-sm bg-red-50 border border-red-200 flex items-center justify-center text-red-400"
        style={{ width: `${size}px`, height: `${size}px`, fontSize: size > 30 ? '10px' : '8px' }}
        title={`文件不存在\n${previewPath}`}
      >
        ✕
      </div>
    );
  }

  // 异步获取缩略图（仅当没有缓存时）
  React.useEffect(() => {
    if (thumbPath || requestedRef.current || loading) return;
    requestedRef.current = true;
    setLoading(true);

    invoke('get_file_thumbnail', { filePath: previewPath })
      .then(path => {
        if (path) setThumbPath(path);
      })
      .catch(() => {}) // 静默失败，显示占位符
      .finally(() => setLoading(false));
  }, [previewPath, thumbPath, loading]);

  // 显示缩略图或占位符
  if (thumbPath) {
    const thumbSrc = convertFileSrc(thumbPath, 'asset');
    return <img 
      src={thumbSrc} 
      alt={file.file_type || '文件'} 
      className="flex-shrink-0 rounded-sm object-cover" 
      style={{ width: `${size}px`, height: `${size}px` }}
      loading="lazy" 
      decoding="async" 
      onError={e => {
        e.target.outerHTML = `<div class="flex-shrink-0 rounded-sm bg-gray-100 border border-gray-200 flex items-center justify-center text-gray-500 font-medium" style="width:${size}px;height:${size}px;font-size:${size > 30 ? '11px' : '9px'}" title="${previewPath}">${getFileExt(file.name) || '?'}</div>`;
      }} 
    />;
  }

  // 加载中/失败：图片文件尝试显示原图，其他显示扩展名
  if (isImageFile && previewPath) {
    const iconSrc = convertFileSrc(previewPath, 'asset');
    return <img 
      src={iconSrc} 
      alt={file.file_type || '文件'} 
      className="flex-shrink-0 rounded-sm object-cover" 
      style={{ width: `${size}px`, height: `${size}px` }}
      loading="lazy" 
      decoding="async" 
      onError={e => {
        e.target.outerHTML = `<div class="flex-shrink-0 rounded-sm bg-gray-100 border border-gray-200 flex items-center justify-center text-gray-500 font-medium" style="width:${size}px;height:${size}px;font-size:${size > 30 ? '11px' : '9px'}" title="${previewPath}">${getFileExt(file.name) || '?'}</div>`;
      }} 
    />;
  }

  // 兜底: 显示文件扩展名
  return (
    <div 
      className="flex-shrink-0 rounded-sm bg-gray-100 border border-gray-200 flex items-center justify-center text-gray-500 font-medium"
      style={{ width: `${size}px`, height: `${size}px`, fontSize: size > 30 ? '11px' : '9px' }}
      title={previewPath}
    >
      {getFileExt(file.name) || '?'}
    </div>
  );
}

// 同步版本（用于不需要异步的场景）
function FileIcon({
  file,
  size = 20
}) {
  return <AsyncFileIcon file={file} size={size} />;
}

// 获取文件扩展名（用于显示）
function getFileExt(filename) {
  if (!filename) return '';
  const ext = filename.split('.').pop()?.toUpperCase();
  return ext && ext.length <= 4 ? ext : '?';
}

function FileContent({
  item,
  compact = false,
  searchKeyword,
  maxContentHeightPx
}) {
  const { t } = useTranslation();
  const settings = useSnapshot(settingsStore);
  const isAutoHeight = settings.rowHeight === 'auto';
  const isXSmallHeight = settings.rowHeight === 'xsmall';
  const autoMaxHeight = Number.isFinite(Number(maxContentHeightPx))
    ? Number(maxContentHeightPx)
    : undefined;
  const autoMaxHeightStyle = isAutoHeight && autoMaxHeight
    ? { maxHeight: `${autoMaxHeight}px` }
    : undefined;
  
  const renderFileName = (name) => {
    return searchKeyword ? highlightText(name, searchKeyword) : name;
  };
  
  const renderFilePath = (path) => {
    return searchKeyword ? highlightText(path, searchKeyword) : path;
  };

  let filesData = null;
  try {
    if (item.content?.startsWith('files:')) {
      const filesJson = item.content.substring(6);
      filesData = JSON.parse(filesJson);
    }
  } catch (error) {
    console.error('解析文件数据失败:', error);
    return <div className="text-sm text-red-500">
      文件数据解析错误
    </div>;
  }
  
  if (!filesData || !filesData.files || filesData.files.length === 0) {
    return <div className="text-sm text-qc-fg-muted">
      无文件信息
    </div>;
  }

  const buildTitle = (file) => {
    return `${file.name}\n${file.path || ''}\n${formatFileSize(file.size || 0)}`;
  };

  // 仅图标模式：网格布局
  if (settings.fileDisplayMode === 'iconOnly') {
    const iconSize = isXSmallHeight ? 18 : compact ? 29 : settings.rowHeight === 'large' ? 80 : settings.rowHeight === 'auto' ? 48 : 50;
    const itemSize = isXSmallHeight ? 22 : compact ? 33 : settings.rowHeight === 'large' ? 84 : settings.rowHeight === 'auto' ? 52 : 54;
    const gap = isXSmallHeight ? '0.125rem' : compact ? '0.25rem' : settings.rowHeight === 'large' || settings.rowHeight === 'auto' ? '0.5rem' : '0.375rem';
    return <div data-drag-ignore="true" className={`w-full overflow-y-auto ${isAutoHeight ? '' : 'h-full'}`} style={autoMaxHeightStyle}>
      <div className="w-full flex flex-wrap" style={{
        gap
      }}>
        {filesData.files.map((file, index) => {
          const exists = file.exists !== false;
          const title = exists ? buildTitle(file) : `${file.name}\n${t('clipboard.fileNotFound', '文件不存在')}`;
          return (
            <div
              key={index}
              className={`flex items-center justify-center rounded border transition-colors flex-shrink-0 ${
                exists 
                  ? `bg-qc-panel border-qc-border hover:border-qc-border-strong`
                  : 'bg-red-50 border-red-300/60 opacity-60'
              }`}
              style={{
                width: `${itemSize}px`,
                height: `${itemSize}px`,
                padding: '2px'
              }}
              title={title}
            >
              <FileIcon file={file} size={iconSize} />
            </div>
          );
        })}
      </div>
    </div>;
  }

  // 小行高模式
  if (compact) {
    if (isXSmallHeight) {
      const firstFile = filesData.files[0];
      const exists = firstFile.exists !== false;
      const totalCount = filesData.files.length;
      const title = exists ? buildTitle(firstFile) : `${firstFile.name}\n${t('clipboard.fileNotFound', '文件不存在')}`;
      const metaText = exists ? formatFileSize(firstFile.size || 0) : t('clipboard.fileNotFound', '文件不存在');
      const countText = totalCount > 1 ? t('clipboard.fileCount', { count: totalCount, defaultValue: `共 ${totalCount} 个文件` }) : null;

      return <div
        className={`w-full h-full flex items-center gap-1.5 px-0.5 overflow-hidden ${exists ? '' : 'opacity-70'}`}
        title={title}
      >
        <FileIcon file={firstFile} size={18} />
        <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-hidden text-xs">
          <span className={`truncate font-medium ${exists ? 'text-qc-fg' : 'text-red-600 line-through'}`}>
            {renderFileName(firstFile.name)}
          </span>
          <span className="text-qc-fg-subtle flex-shrink-0">
            {metaText}
          </span>
          {countText ? (
            <span className="text-qc-fg-subtle truncate">
              {countText}
            </span>
          ) : null}
        </div>
      </div>;
    }

    return <div className="w-full h-full overflow-hidden">
      {filesData.files.map((file, index) => {
        const exists = file.exists !== false;
        const title = exists ? buildTitle(file) : `${file.name}\n${t('clipboard.fileNotFound', '文件不存在')}`;
        return (
          <div
            key={index}
            className={`flex items-center gap-1 px-1 rounded border transition-colors h-full ${
              exists
                ? `bg-qc-panel border-qc-border hover:border-qc-border-strong`
                : 'bg-red-50 border-red-300/60 opacity-60'
            }`}
            title={title}
          >
            <FileIcon file={file} size={24} />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-1">
                <span className={`text-xs truncate font-medium ${exists ? 'text-qc-fg' : 'text-red-600 line-through'}`}>
                  {renderFileName(file.name)}
                </span>
                <span className="text-xs text-qc-fg-subtle flex-shrink-0">
                  {exists ? formatFileSize(file.size || 0) : t('clipboard.fileNotFound', '文件不存在')}
                </span>
              </div>
              <div className="text-xs text-qc-fg-muted truncate leading-tight">
                {renderFilePath(file.path)}
              </div>
            </div>
          </div>
        );
      })}
    </div>;
  }

  // 正常模式
  const normalIconSize = settings.rowHeight === 'large' || settings.rowHeight === 'auto' ? 48 : 36;
  return <div data-drag-ignore="true" className={`w-full overflow-y-auto space-y-1 pr-1 ${isAutoHeight ? '' : 'h-full'}`} style={autoMaxHeightStyle}>
    {/* 文件列表 */}
    {filesData.files.map((file, index) => {
      const exists = file.exists !== false;
      const title = exists ? buildTitle(file) : `${file.name}\n${t('clipboard.fileNotFound', '文件不存在')}`;
      return (
        <div
          key={index}
          className={`flex items-center gap-2 px-2 py-1.5 rounded border transition-colors ${isAutoHeight ? '' : 'h-full'} ${
            exists
              ? `bg-qc-panel border-qc-border hover:border-qc-border-strong`
              : 'bg-red-50 border-red-300/60 opacity-60'
          }`}
          title={title}
        >
          {/* 文件图标 */}
          <FileIcon file={file} size={normalIconSize} />

          {/* 文件信息 */}
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <span className={`text-sm truncate font-medium ${exists ? 'text-qc-fg' : 'text-red-600 line-through'}`}>
                {renderFileName(file.name)}
              </span>
              <span className="text-xs text-qc-fg-subtle flex-shrink-0">
                {exists ? formatFileSize(file.size || 0) : t('clipboard.fileNotFound', '文件不存在')}
              </span>
            </div>
            <div className="text-xs text-qc-fg-muted truncate mt-0.5">
              {renderFilePath(file.path)}
            </div>
          </div>
        </div>
      );
    })}
  </div>;
}
export default FileContent;
