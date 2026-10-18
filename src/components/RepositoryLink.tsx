import React from 'react';

export const REPOSITORY_URL = 'https://github.com/SuspensionPoint/space-station-14-map-editor';

interface Props {
  className?: string;
  label?: string;
  variant?: 'compact' | 'button' | 'toolbar';
}

export const RepositoryLink: React.FC<Props> = ({
  className = '',
  label = 'GitHub repository',
  variant = 'compact',
}) => {
  const variantClasses = {
    compact: 'gap-1 text-[10px] text-muted hover:text-accent focus-visible:text-accent',
    button: 'w-full justify-center gap-1.5 rounded-lg border border-subtle bg-elevated px-4 py-2.5 text-sm font-medium text-primary hover:bg-hover active:brightness-90 focus-visible:ring-2 focus-visible:ring-accent/50',
    toolbar: 'w-full flex-col justify-center gap-0.5 py-2 text-[10px] text-muted hover:bg-hover hover:text-primary focus-visible:text-primary',
  }[variant];

  const iconClasses = variant === 'button'
    ? 'h-4 w-4'
    : variant === 'toolbar'
      ? 'h-5 w-5'
      : 'h-3 w-3';

  return (
    <a
      href={REPOSITORY_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Open the SS14 Map Editor repository on GitHub"
      title={variant === 'toolbar' ? 'Open GitHub repository' : undefined}
      className={`inline-flex shrink-0 items-center no-underline transition-all focus-visible:outline-none ${variantClasses} ${className}`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className={`${iconClasses} fill-current`}
      >
        <path d="M12 .7A11.5 11.5 0 0 0 8.36 23.1c.58.11.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.72 1.27 3.38.97.1-.75.41-1.27.74-1.56-2.57-.29-5.27-1.28-5.27-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.16 1.18a10.98 10.98 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.75.11 3.04.74.8 1.19 1.83 1.19 3.09 0 4.42-2.71 5.39-5.29 5.68.42.36.79 1.06.79 2.14v3.27c0 .31.21.68.8.56A11.5 11.5 0 0 0 12 .7Z" />
      </svg>
      <span>{label}</span>
    </a>
  );
};
