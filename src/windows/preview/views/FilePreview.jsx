import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState, useEffect } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { Virtuoso } from 'react-virtuoso';
import { formatFileSize } from '@shared/utils/format';

function getFileIconClass(file) {
  if (file?.isDirectory) {
    return 'ti ti-folder';
  }

  if (file?.fileType && /^(png|jpe?g|gif|bmp|webp|ico|svg|tif?f)$/i.test(file.fileType)) {
    return 'ti ti-photo';
  }

  if (file?.exists === false) {
    return 'ti ti-file-off';
  }

  return 'ti ti-file';
}

// 异步缩略图组件：与主窗口保持一致的加载逻辑
function FileIcon({ file, size = 28 }) {
  const isImageFile = file?.fileType && /^(png|jpe?g|gif|bmp|webp|ico|svg|tif?f)$/i.test(file.fileType);
  const actualPath = file?.actualPath || file?.path || '';
  const [thumbPath, setThumbPath] = useState(file?.thumbnailPath || null);
  const requestedRef = useRef(false);

  // 文件不存在：直接显示图标
  if (file?.exists === false) {
    return (
      <span className="flex items-center justify-center text-qc-fg-muted">
        <i className="ti ti-file-off" style={{ fontSize: Math.max(14, Math.round(size * 0.55)) }} />
      </span>
    );
  }

  // 异步获取缩略图（与主窗口逻辑一致）
  useEffect(() => {
    if (thumbPath || requestedRef.current || !actualPath) return;
    requestedRef.current = true;

    invoke('get_file_thumbnail', { filePath: actualPath })
      .then(path => {
        if (path) setThumbPath(path);
      })
      .catch(() => {}); // 静默失败
  }, [actualPath, thumbPath]);

  // 显示缩略图
  if (thumbPath) {
    return (
      <img
        src={convertFileSrc(thumbPath, 'asset')}
        alt={file?.name || '文件'}
        className="flex-shrink-0 rounded-sm object-cover"
        style={{
          width: `${size}px`,
          height: `${size}px`,
        }}
        loading="lazy"
        decoding="async"
        onError={(e) => {
          // 加载失败，显示图标
          e.target.outerHTML = `<span class="flex items-center justify-center text-qc-fg-subtle"><i class="ti ${getFileIconClass(file)}" style="fontSize: ${Math.max(14, Math.round(size * 0.55))}px"></i></span>`;
        }}
      />
    );
  }

  // 加载中或无缩略图：图片文件尝试显示原图
  if (isImageFile && actualPath) {
    return (
      <img
        src={convertFileSrc(actualPath, 'asset')}
        alt={file?.name || '文件'}
        className="flex-shrink-0 rounded-sm object-cover"
        style={{
          width: `${size}px`,
          height: `${size}px`,
        }}
        loading="lazy"
        decoding="async"
        onError={(e) => {
          e.target.outerHTML = `<span class="flex items-center justify-center text-qc-fg-subtle"><i class="ti ti-photo" style="fontSize: ${Math.max(14, Math.round(size * 0.55))}px"></i></span>`;
        }}
      />
    );
  }

  // 旧版 base64 图标（兼容历史数据）
  if (file?.iconData) {
    return (
      <img
        src={file.iconData}
        alt={file?.name || '文件'}
        className="flex-shrink-0"
        style={{
          width: `${size}px`,
          height: `${size}px`,
          objectFit: 'contain',
        }}
      />
    );
  }

  // 兜底: Tabler 图标
  return (
    <span className="flex items-center justify-center text-qc-fg-subtle">
      <i className={getFileIconClass(file)} style={{ fontSize: Math.max(14, Math.round(size * 0.55)) }} />
    </span>
  );
}

function MarqueeText({ text, className = '', title, textClassName = '' }) {
  const outerRef = useRef(null);
  const contentRef = useRef(null);
  const [shouldMarquee, setShouldMarquee] = useState(false);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const content = contentRef.current;
    if (!outer || !content) {
      return undefined;
    }

    let rafId = 0;
    let observer = null;

    const measure = () => {
      rafId = requestAnimationFrame(() => {
        const outerWidth = outer.clientWidth || 0;
        const contentWidth = content.scrollWidth || 0;
        setShouldMarquee(contentWidth > outerWidth + 2);
      });
    };

    measure();

    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(outer);
      observer.observe(content);
    } else {
      window.addEventListener('resize', measure);
    }

    return () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      if (observer) {
        observer.disconnect();
      } else {
        window.removeEventListener('resize', measure);
      }
    };
  }, [text]);

  if (!text) {
    return <span className={textClassName} title={title || ''} />;
  }

  if (!shouldMarquee) {
    return (
      <span ref={outerRef} className={`block min-w-0 ${className}`} title={title || text}>
        <span className={`block truncate ${textClassName}`} ref={contentRef}>
          {text}
        </span>
      </span>
    );
  }

  return (
    <span ref={outerRef} className={`qc-file-marquee block min-w-0 overflow-hidden ${className}`} title={title || text}>
      <span ref={contentRef} className="inline-flex w-max items-center whitespace-nowrap">
        <span className={textClassName}>{text}</span>
        <span aria-hidden="true" className={`ml-8 ${textClassName}`}>
          {text}
        </span>
      </span>
    </span>
  );
}

const FILE_ROW_MIN_WIDTH = 320;
const FILE_ICON_SIZE = 32;

const FilePreviewList = forwardRef(function FilePreviewList(props, ref) {
  return (
    <div
      ref={ref}
      {...props}
      style={{
        ...(props.style || {}),
        minWidth: `${FILE_ROW_MIN_WIDTH}px`,
      }}
      className={`${props.className || ''} pr-1`}
    />
  );
});

function getStatusLabel(file, t) {
  if (file?.exists === false) {
    return t('previewWindow.fileStatusMissing', '文件不存在');
  }

  if (file?.isDirectory) {
    return t('previewWindow.fileStatusDirectory', '目录');
  }

  return t('previewWindow.fileStatusReady', '可用');
}

function getTypeLabel(file, t) {
  if (file?.isDirectory) {
    return t('previewWindow.fileTypeDirectory', '目录');
  }

  if (file?.fileType) {
    return String(file.fileType).toUpperCase();
  }

  return t('previewWindow.fileTypeUnknown', '文件');
}

function getDetailText(file, t) {
  const width = Number(file?.width);
  const height = Number(file?.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return `${width} × ${height}`;
  }

  if (file?.isDirectory) {
    return t('previewWindow.fileExtraDirectory', '目录项');
  }

  return '';
}

function FileSummaryItem({ label, value, subtle = false }) {
  return (
    <span className={`inline-flex items-baseline gap-1 whitespace-nowrap ${subtle ? 'text-qc-fg-muted' : 'text-qc-fg-subtle'}`}>
      <span className="text-[10px] text-qc-fg-muted">{label}</span>
      <span className="text-[11px] font-medium tabular-nums">{value}</span>
    </span>
  );
}

const FilePreview = forwardRef(function FilePreview(
  {
    files = [],
    stats = null,
    t,
    onScrollabilityChange,
  },
  ref,
) {
  const scrollerElementRef = useRef(null);
  const onScrollabilityChangeRef = useRef(onScrollabilityChange);
  const setScrollerElement = useCallback((element) => {
    scrollerElementRef.current = element || null;
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      scrollBy(delta) {
        scrollerElementRef.current?.scrollBy({ top: delta, behavior: 'auto' });
      },
      hasVerticalOverflow() {
        const element = scrollerElementRef.current;
        if (!element) {
          return false;
        }
        return (element.scrollHeight - element.clientHeight) > 2;
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    onScrollabilityChangeRef.current = onScrollabilityChange;
  }, [onScrollabilityChange]);

  useLayoutEffect(() => {
    const element = scrollerElementRef.current;
    if (!element) {
      onScrollabilityChangeRef.current?.(false);
      return undefined;
    }

    let rafId = 0;
    let observer = null;
    let previousValue = null;

    const measure = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const nextValue = (element.scrollHeight - element.clientHeight) > 2;
        if (nextValue === previousValue) {
          return;
        }
        previousValue = nextValue;
        onScrollabilityChangeRef.current?.(nextValue);
      });
    };

    measure();

    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(element);
    } else {
      window.addEventListener('resize', measure);
    }

    return () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      if (observer) {
        observer.disconnect();
      } else {
        window.removeEventListener('resize', measure);
      }
    };
  }, [files.length]);

  if (!Array.isArray(files) || files.length === 0) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-4 py-3 text-sm text-qc-fg-muted">
        {t('previewWindow.fileEmpty', '没有可预览的文件')}
      </div>
    );
  }

  const totalSize = Number(stats?.totalSize) || 0;
  const fileCount = Number(stats?.fileCount) || files.length || 0;
  const directoryCount = Number(stats?.directoryCount) || 0;
  const missingCount = Number(stats?.missingCount) || 0;
  const defaultItemHeight = 58;

  return (
    <div className="preview-file-content flex h-full min-h-0 flex-col overflow-hidden">
      <style>{`
        @keyframes qc-preview-file-marquee {
          0% {
            transform: translateX(0);
          }
          100% {
            transform: translateX(-50%);
          }
        }

        .qc-file-marquee > span {
          animation: qc-preview-file-marquee 12s linear infinite;
          will-change: transform;
        }

        .qc-file-marquee:hover > span {
          animation-play-state: paused;
        }
      `}</style>

      <div className="preview-file-summary flex items-center gap-3 overflow-hidden border-b border-qc-border/60 bg-qc-panel/55 px-3 py-2 backdrop-blur-md">
        <FileSummaryItem label={t('previewWindow.fileSummaryCountLabel', '项目')} value={fileCount} />
        <FileSummaryItem label={t('previewWindow.fileSummarySizeLabel', '总计')} value={formatFileSize(totalSize)} />
        {directoryCount > 0 && (
          <FileSummaryItem label={t('previewWindow.fileSummaryDirectoryLabel', '目录')} value={directoryCount} subtle />
        )}
        {missingCount > 0 && (
          <FileSummaryItem label={t('previewWindow.fileSummaryMissingLabel', '缺失')} value={missingCount} subtle />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-2 py-2">
        <Virtuoso
          totalCount={files.length}
          data={files}
          scrollerRef={setScrollerElement}
          defaultItemHeight={defaultItemHeight}
          increaseViewportBy={{ top: 240, bottom: 320 }}
          overscan={8}
          computeItemKey={(index) => {
            const file = files[index];
            return file?.actualPath || file?.path || file?.name || `file-${index}`;
          }}
          style={{ height: '100%' }}
          className="h-full custom-scrollbar-container"
          components={{
            List: FilePreviewList,
          }}
          itemContent={(index, file) => {
            const statusLabel = getStatusLabel(file, t);
            const typeLabel = getTypeLabel(file, t);
            const detailText = getDetailText(file, t);
            const displayPath = file?.displayPath || file?.actualPath || file?.path || '';
            const storedPath = file?.path || '';
            const pathMismatch = Boolean(file?.actualPath && storedPath && file.actualPath !== storedPath);
            const sizeLabel = file?.isDirectory
              ? t('previewWindow.fileSizeDirectory', '目录')
              : formatFileSize(Number(file?.size) || 0);
            const nameTextClass = file?.exists === false ? 'text-qc-fg-muted line-through' : 'text-qc-fg';
            const pathTextClass = file?.exists === false ? 'text-qc-fg-muted' : 'text-qc-fg-subtle';
            const rowStateClass = file?.exists === false
              ? 'border-qc-border/70 bg-qc-active/20'
              : 'border-transparent bg-transparent hover:border-qc-border/70 hover:bg-qc-hover/55';
            const iconStateClass = file?.exists === false ? 'opacity-65' : '';

            return (
              <div className="w-full pb-1" style={{ minWidth: `${FILE_ROW_MIN_WIDTH}px` }}>
                <div
                  className={`preview-file-row flex min-h-[54px] items-center gap-2 rounded-md border px-2 py-1.5 transition-colors ${rowStateClass}`}
                >
                  <span
                    className={`preview-file-icon-shell flex h-8 w-8 flex-shrink-0 items-center justify-center overflow-hidden rounded border border-qc-border/70 bg-qc-surface/80 text-qc-fg-subtle ${iconStateClass}`}
                  >
                    <FileIcon file={file} size={FILE_ICON_SIZE} />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <MarqueeText
                        text={file?.name || t('previewWindow.fileUnknownName', '未命名文件')}
                        title={file?.name || ''}
                        className="min-w-0 flex-1"
                        textClassName={`text-[13px] font-medium leading-5 ${nameTextClass}`}
                      />
                      <span className="preview-file-type-chip inline-flex max-w-[72px] flex-shrink-0 items-center truncate rounded border border-qc-border/70 bg-qc-panel/60 px-1.5 py-0.5 text-[10px] font-medium leading-4 text-qc-fg-muted">
                        {typeLabel}
                      </span>
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] leading-4">
                      {detailText && (
                        <span className="flex-shrink-0 text-qc-fg-muted">
                          {detailText}
                        </span>
                      )}
                      <MarqueeText
                        text={displayPath || t('previewWindow.fileNoPath', '无路径信息')}
                        title={displayPath}
                        className="min-w-0 flex-1"
                        textClassName={pathTextClass}
                      />
                    </div>
                    {pathMismatch && (
                      <MarqueeText
                        text={t('previewWindow.fileStoredPath', '存储路径：{{path}}', { path: storedPath })}
                        title={storedPath}
                        className="mt-0.5 min-w-0"
                        textClassName="text-[11px] leading-4 text-qc-fg-muted"
                      />
                    )}
                  </div>

                  <div className="ml-1 flex w-[86px] flex-shrink-0 flex-col items-end justify-center gap-1 text-right">
                    <span className="max-w-full truncate text-[12px] leading-4 text-qc-fg tabular-nums">
                      {sizeLabel}
                    </span>
                    <span
                      className={`preview-file-status-chip inline-flex max-w-full items-center rounded-full border px-1.5 py-0.5 text-[10px] leading-3 ${
                        file?.exists === false
                          ? 'border-qc-border bg-qc-active/20 text-qc-fg'
                          : 'border-qc-border/70 bg-qc-panel/60 text-qc-fg-muted'
                      }`}
                    >
                      {statusLabel}
                    </span>
                  </div>
                </div>
              </div>
            );
          }}
        />
      </div>
    </div>
  );
});

export default FilePreview;
