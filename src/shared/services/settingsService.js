import {
  reloadSettings,
  saveSettings as saveSettingsApi,
  setEdgeHideEnabled as setEdgeHideEnabledApi,
  getAllWindowsInfo,
  hideMainWindowIfAutoShown,
  getAppVersion as getAppVersionApi,
  isPortableMode as isPortableModeApi
} from '@shared/api'
import { emit } from '@tauri-apps/api/event'
import { toast } from '@shared/store/toastStore'
import i18n from '@shared/i18n'

import { defaultSettings } from './defaultSettings'

export { defaultSettings }

// 加载设置
export async function loadSettingsFromBackend() {
  try {
    const savedSettings = await reloadSettings()

    const mergedSettings = { ...defaultSettings, ...savedSettings }
    
    return mergedSettings
  } catch (error) {
    console.error('加载设置失败:', error)
    return { ...defaultSettings }
  }
}

// 保存设置
export async function saveSettingsToBackend(settings, options = {}) {
  const { showToast = true } = options
  
  try {
    await saveSettingsApi(settings)
    
    await emit('settings-changed', settings)
    
    if (showToast) {
      toast.success(i18n.t('settings.saved'))
    }
    return { success: true }
  } catch (error) {
    console.error('保存设置失败:', error)
    if (showToast) {
      toast.error(i18n.t('settings.saveFailed'))
    }
    return { success: false, error: error.message }
  }
}

// 保存单个设置项
export async function saveSingleSetting(key, value, allSettings) {
  const updatedSettings = { ...allSettings, [key]: value }
  return await saveSettingsToBackend(updatedSettings)
}

// 获取应用版本
export async function getAppVersion() {
  try {
    const versionInfo = await getAppVersionApi()
    return versionInfo
  } catch (error) {
    console.error('获取版本信息失败:', error)
    return { version: '未知' }
  }
}


// 检查是否为便携版模式
export async function isPortableMode() {
  try {
    return await isPortableModeApi()
  } catch (error) {
    console.error('检查便携版模式失败:', error)
    return false
  }
}

// 设置贴边隐藏
export async function setEdgeHideEnabled(enabled) {
  try {
    await setEdgeHideEnabledApi(enabled)
    return { success: true }
  } catch (error) {
    console.error('更新贴边隐藏设置失败:', error)
    return { success: false, error: error.message }
  }
}

// 获取所有窗口信息（用于应用过滤）
export async function getAllWindowsInfoService() {
  try {
    return await getAllWindowsInfo()
  } catch (error) {
    console.error('获取应用列表失败:', error)
    return []
  }
}

// 隐藏主窗口
export async function hideMainWindowIfAutoShownService() {
  try {
    await hideMainWindowIfAutoShown()
  } catch (error) {
    console.error('隐藏主窗口失败:', error)
  }
}

