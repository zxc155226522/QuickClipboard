import '@tabler/icons-webfont/dist/tabler-icons.min.css';
import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { useInputFocus, focusWindowImmediately } from '@shared/hooks/useInputFocus';
import { useSnapshot } from 'valtio';
import { settingsStore } from '@shared/store/settingsStore';
const TitleBarSearch = forwardRef(({
  value,
  onChange,
  placeholder,
  isVertical = false,
  position = 'top'
}, ref) => {
  const [inputValue, setInputValue] = useState(value || '');
  const inputRef = useInputFocus();
  const isComposingRef = useRef(false);
  const settings = useSnapshot(settingsStore);

  // 搜索框清空按钮样式
  const searchInputStyle = `
        .titlebar-search input[type="search"]::-webkit-search-cancel-button {
            -webkit-appearance: none;
            appearance: none;
            height: 14px;
            width: 14px;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23ef4444' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cline x1='18' y1='6' x2='6' y2='18'%3E%3C/line%3E%3Cline x1='6' y1='6' x2='18' y2='18'%3E%3C/line%3E%3C/svg%3E");
            background-size: 14px 14px;
            cursor: pointer;
            opacity: 0.6;
            transition: opacity 0.2s;
        }
        .titlebar-search input[type="search"]::-webkit-search-cancel-button:hover {
            opacity: 1;
        }
    `;

  useEffect(() => {
    if (!isComposingRef.current) {
      setInputValue(value || '');
    }
  }, [value]);

  const handleFocus = () => {
    if (inputRef.current && inputValue) {
      setTimeout(() => {
        inputRef.current.select();
      }, 100);
    }
  };
  const handleChange = e => {
    const nextValue = e.target.value;
    setInputValue(nextValue);

    if (e.nativeEvent?.isComposing || isComposingRef.current) {
      return;
    }

    onChange(nextValue);
  };
  const handleCompositionStart = () => {
    isComposingRef.current = true;
  };
  const handleCompositionEnd = e => {
    const nextValue = e.currentTarget.value;
    isComposingRef.current = false;
    setInputValue(nextValue);
    onChange(nextValue);
  };

  useImperativeHandle(ref, () => ({
    focus: async () => {
      if (inputRef.current) {
        try {
          await focusWindowImmediately();
          inputRef.current.focus();
          inputRef.current.select();
        } catch (error) {
          console.error('聚焦搜索框失败:', error);
        }
      }
    },
    blur: () => {
      inputRef.current?.blur();
    },
    toggleFocus: async () => {
      if (document.activeElement === inputRef.current) {
        inputRef.current.blur();
        return;
      }

      if (inputRef.current) {
        try {
          await focusWindowImmediately();
          inputRef.current.focus();
          inputRef.current.select();
        } catch (error) {
          console.error('切换搜索框焦点失败:', error);
        }
      }
    },
    isFocused: () => document.activeElement === inputRef.current
  }));

  if (isVertical) {
    return <>
        <style>{searchInputStyle}</style>
        <div className="titlebar-search relative flex flex-col items-center justify-end h-7">
            <input ref={inputRef} type="search" value={inputValue} onChange={handleChange} onCompositionStart={handleCompositionStart} onCompositionEnd={handleCompositionEnd} onFocus={handleFocus} placeholder={placeholder} style={{
        writingMode: 'vertical-rl',
        textAlign: 'start'
      }} className="absolute bottom-6 left-0 w-7 py-2 text-sm bg-qc-panel border border-qc-border rounded-lg outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 text-qc-fg placeholder:text-qc-fg-subtle shadow-sm" />
        </div>
    </>;
  }

  return <>
        <style>{searchInputStyle}</style>
        <div className="titlebar-search min-w-0 flex-1 flex-row items-center">
            <input ref={inputRef} type="search" value={inputValue} onChange={handleChange} onCompositionStart={handleCompositionStart} onCompositionEnd={handleCompositionEnd} onFocus={handleFocus} placeholder={placeholder} className="h-7 w-full min-w-0 px-2 text-sm bg-qc-panel border border-qc-border rounded-lg outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 text-qc-fg placeholder:text-qc-fg-subtle shadow-sm" />
        </div>
    </>;
});
TitleBarSearch.displayName = 'TitleBarSearch';
export default TitleBarSearch;
