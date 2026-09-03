import { avatarFor } from '@rcb/core';

interface Props {
  assignee: string;
  /** Pulsing ring: someone is working here (D8). */
  active?: boolean;
  bounce?: boolean;
  size?: 'sm' | 'md';
}

export function Avatar({ assignee, active = false, bounce = false, size = 'sm' }: Props) {
  const { emoji, color } = avatarFor(assignee);
  const cls = [
    'avatar',
    `avatar--${size}`,
    active ? 'avatar--active' : '',
    bounce ? 'avatar--bounce' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span
      className={cls}
      style={{ '--avatar': color } as React.CSSProperties}
      title={assignee}
      data-testid="avatar"
    >
      <span className="avatar__emoji" aria-hidden="true">
        {emoji}
      </span>
      <span className="sr-only">{assignee}</span>
    </span>
  );
}
