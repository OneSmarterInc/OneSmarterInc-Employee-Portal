const oneSmarterLogo = 'https://raw.githubusercontent.com/OneSmarterInc/onesmarterweb/main/src/Images/ONESMARTER.png'

export default function BrandLogo({ compact = false }) {
  return <div className={`brand-logo-lockup ${compact ? 'compact' : ''}`}>
    <img className="brand-wordmark" src={oneSmarterLogo} alt="OneSmarter, Inc." />
    {!compact && <span className="portal-label">People Portal</span>}
  </div>
}
