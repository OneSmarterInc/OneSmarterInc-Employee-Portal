export default function BrandLogo({ compact = false }) {
  return <div className={`brand-logo-lockup ${compact ? 'compact' : ''}`}>
    <picture>
      <source srcSet="/onesmarter-logo.png" type="image/png" />
      <img className="brand-wordmark" src="/onesmarter-logo.svg" alt="OneSmarter, Inc." />
    </picture>
    {!compact && <span className="portal-label">People Portal</span>}
  </div>
}
