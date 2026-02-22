import { Switch } from 'antd'
import { SunOutlined, MoonOutlined } from '@ant-design/icons'
import { useAppStore } from '../stores/appStore'

export function ThemeToggle() {
  const themeMode = useAppStore(s => s.themeMode)
  const setThemeMode = useAppStore(s => s.setThemeMode)

  return (
    <Switch
      checked={themeMode === 'dark'}
      onChange={(checked) => setThemeMode(checked ? 'dark' : 'light')}
      checkedChildren={<MoonOutlined />}
      unCheckedChildren={<SunOutlined />}
      size="small"
    />
  )
}
