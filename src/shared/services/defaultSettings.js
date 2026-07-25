// 默认设置（零依赖模块，避免与 settingsStore 形成循环依赖导致 TDZ）
export const defaultSettings = {
  // 常规设置
  autoStart: false,
  runAsAdmin: false,
  startHidden: false,
  showTrayIcon: true,
  showStartupNotification: true,
  autoLowMemoryEnabled: false,
  autoLowMemoryIdleMinutes: 15,
  autoExitLowMemoryMode: false,
  memoryOptimizationEnabled: false,
  historyLimit: 100,
  language: 'zh-CN',
  
  // 外观设置
  tooltipsEnabled: true,
  theme: 'light',
  lightThemeStyle: 'modern',
  darkThemeStyle: 'classic',
  customFontEnabled: false,
  customFontType: 'file',
  customFontPath: '',
  customFontUrl: '',
  customFontFamily: '',
  visibleOptionalTabs: ['favorites'],
  opacity: 0.9,
  backgroundImagePath: '',
  superBackgroundBlurScale: 1,
  clipboardAnimationEnabled: true,
  uiAnimationEnabled: true,

  // 列表外观
  listStyle: 'card', 
  rowHeight: 'medium',
  autoRowMaxLines: 18,
  fileDisplayMode: 'detailed', 
  cardSpacing: 8, 
  
  // 快捷键设置
  toggleShortcut: 'Shift+Space',
  openSettingsShortcut: '',
  quickpasteShortcut: 'Ctrl+`',
  transferShelfCreateShortcut: '',
  numberShortcuts: true,
  numberShortcutsModifier: 'Ctrl',
  
  // 剪贴板窗口快捷键
  navigateUpShortcut: 'ArrowUp',
  navigateDownShortcut: 'ArrowDown',
  tabLeftShortcut: 'ArrowLeft',
  tabRightShortcut: 'ArrowRight',
  focusSearchShortcut: 'Tab',
  hideWindowShortcut: 'Escape',
  pasteItemShortcut: 'Enter',
  previousGroupShortcut: 'Ctrl+ArrowUp',
  nextGroupShortcut: 'Ctrl+ArrowDown',
  togglePinShortcut: 'Ctrl+P',
  toggleClipboardMonitorShortcut: '',
  togglePasteWithFormatShortcut: '',
  toggleLowMemoryModeShortcut: '',
  pastePlainTextShortcut: '',
  
  // 剪贴板设置
  clipboardMonitor: true,
  ignoreDuplicates: true,
  saveImages: true,
  imagePreview: true,
  textPreview: true,
  filePreview: true,
  // 悬浮预览窗固定尺寸（像素，逻辑像素）
  previewWindowWidth: 300,
  previewWindowHeight: 300,
  settingsMigrationVersion: 1,
  displayPriorityOrder: 'text,html,image',
  autoScrollToTopOnShow: false,
  autoClearSearch: false,
  windowPositionMode: 'smart',
  rememberWindowSize: true,
  titleBarPosition: 'top',
  edgeHideEnabled: true,
  edgeSnapPosition: null,
  edgeHideOffset: 3,
  autoFocusSearch: false,
  pasteWithFormat: true,
  pasteShortcutMode: 'ctrl_v',
  modifierClickMultiSelect: true,
  pasteToTop: false,
  showListShortcuts: true,
  showListIndex: true,
  showBadges: true,
  showSourceIcon: true,
  updateCheckInterval: 'daily',
  disableUpdatePopup: false,
  includeBetaUpdates: null,
  
  // 音效设置
  soundEnabled: true,
  soundVolume: 50,
  copySoundPath: '',
  pasteSoundPath: '',
  copySoundTiming: 'success',  
  pasteSoundTiming: 'success', 

  // 图片显示限制
  imageMaxSizeMb: 15,
  imageMaxWidth: 4096,
  imageMaxHeight: 4096,
  
  // 便捷粘贴设置
  quickpasteEnabled: true,
  quickpastePasteOnModifierRelease: true,
  quickpasteScrollSound: true,
  quickpasteScrollSoundPath: 'sounds/roll.mp3',
  
  // AI 配置
  aiTranslationEnabled: false,
  aiApiKey: '',
  aiModel: 'Qwen/Qwen2-7B-Instruct',
  aiBaseUrl: 'https://api.siliconflow.cn/v1',
  aiTargetLanguage: 'auto',
  aiTranslateOnCopy: false,
  aiTranslateOnPaste: true,
  aiTranslationPrompt: '请将以下文本翻译成{target_language}，严格保持原文的所有格式、换行符、段落结构和空白字符，只返回翻译结果，不要添加任何解释或修改格式：',
  aiInputSpeed: 50,
  aiNewlineMode: 'auto',
  aiOutputMode: 'stream',
  
  // 鼠标设置
  mouseMiddleButtonEnabled: false,
  mouseMiddleButtonModifier: 'None',
  mouseMiddleButtonTrigger: 'short_press',
  mouseMiddleButtonLongPressMs: 300,
  
  // 应用过滤
  appFilterEnabled: false,
  appFilterBlocklist: [],
  appFilterEffect: 'clipboard_only',
  
  // 保存的窗口状态
  savedWindowPosition: null,
  savedWindowSize: null,
  
  // 数据存储设置
  customStoragePath: null,
  useCustomStorage: false,

  // WebDAV Sync 设置
  webdavEnabled: false,
  webdavUrl: '',
  webdavUsername: '',
  webdavPassword: '',
  webdavRootPath: 'quickclipboard',
  webdavAutoPush: false,
  webdavPushDelaySecs: 10,
  webdavAutoPull: false,
  webdavAutoPullOnWindowShow: false,
  webdavPullIntervalSecs: 30,
  webdavPushShortcut: '',
  webdavPullShortcut: '',
  webdavSyncClipboard: true,
  webdavSyncFavorites: true,
  webdavSyncImages: false,
  syncTransferActiveMode: 'webdav',

}
