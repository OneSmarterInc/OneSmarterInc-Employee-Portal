const suppliedLogo = 'https://raw.githubusercontent.com/OneSmarterInc/onesmarterweb/main/src/Images/ONESMARTER.png'

export default function BrandLogo({ compact = false }) {
  return <div className={`brand-logo-lockup ${compact ? 'compact' : ''}`}>
    <img className="brand-logo-image" src={suppliedLogo} alt="OneSmarter, Inc." />
    <span className="brand-portal-label">People Portal</span>
  </div>
}
