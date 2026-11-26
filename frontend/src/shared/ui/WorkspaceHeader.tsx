import { Icon } from './Icon'
import softlineLogoWhite from '../assets/softline/softline-solutions-sofl-white.svg'
import softlineLogoColor from '../assets/softline/softline-solutions-sofl.png'
import { useTheme } from '../lib/theme'

export function WorkspaceHeader({ section = 'chat' }: { section?: 'chat' | 'manager' }) {
  const { theme, toggleTheme } = useTheme()
  const themeLabel = theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'
  return <>
    <a className="skip-link" href={section === 'chat' ? '#consultant-workspace' : '#manager-workspace'} onClick={(event) => {
      const target = document.getElementById(section === 'chat' ? 'consultant-workspace' : 'manager-workspace')
      if (target) { event.preventDefault(); target.focus() }
    }}>{section === 'chat' ? 'Перейти к консультации' : 'Перейти к обращениям'}</a>
    <header className="header"><div className="header-inner">
      <a className="brand" href="https://store.softline.ru/" target="_blank" rel="noopener noreferrer" aria-label="Softline Store — открыть магазин">
        <img className="brand-image" src={theme === 'dark' ? softlineLogoWhite : softlineLogoColor} width="524" height="115" alt="Софтлайн РЕШЕНИЯ · SOFL" />
      </a>
      <nav className="header-nav" aria-label="Разделы Softline AI Support">
        <a className="store-link" href="https://store.softline.ru/" target="_blank" rel="noopener noreferrer">Магазин Softline<Icon name="external" /></a>
        <div className="section-switch">
          <a href="#/chat" className={section === 'chat' ? 'nav-current' : ''} aria-current={section === 'chat' ? 'page' : undefined}><Icon name="assistant" /><span>Клиент</span></a>
          <a href="#/manager" className={section === 'manager' ? 'nav-current' : ''} aria-current={section === 'manager' ? 'page' : undefined}><Icon name="inbox" /><span>Менеджер</span></a>
        </div>
        <button className="theme-toggle" type="button" onClick={toggleTheme} aria-label={themeLabel} title={themeLabel}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
      </nav>
    </div></header>
  </>
}

export function DemoBanner() {
  return <aside className="mock-banner"><span className="demo-tag">ДЕМО</span>Демонстрационный режим · используются синтетические данные</aside>
}
