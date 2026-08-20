const officialLogo = 'https://raw.githubusercontent.com/OneSmarterInc/onesmarterweb/main/src/Images/ONESMARTER.png'

export default function BrandLogo({ compact = false }) {
  return <div className={`brand-logo-lockup ${compact ? 'compact' : ''}`}>
    <div className="brand-logo-mark">
      <img src={officialLogo} alt="One Smarter Inc." onError={e=>{e.currentTarget.style.display='none';const fallback=e.currentTarget.nextElementSibling;if(fallback)fallback.style.display='grid'}}/>
      <span className="brand-logo-fallback">OS</span>
    </div>
    <div className="brand-logo-copy"><strong>One Smarter Inc.</strong><span>People Portal</span></div>
  </div>
}
