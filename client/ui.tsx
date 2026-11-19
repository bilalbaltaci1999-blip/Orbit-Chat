/** Ortak arayüz bileşenleri: ikonlar, avatar, modal, bildirimler, yardımcılar. */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { PublicUser, UserStatus } from '@shared/types';

/* ----------------------------------- ikonlar -------------------------------- */

const PATHS: Record<string, string> = {
  hash: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  volume: 'M11 5 6 9H3v6h3l5 4V5zM15.5 8.5a5 5 0 0 1 0 7',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  micOff: 'M3 3l18 18M9 9v3a3 3 0 0 0 4.6 2.5M15 11V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 10.7 6M12 18v3',
  headphones: 'M4 15v-3a8 8 0 0 1 16 0v3M4 15a2 2 0 0 0 2 2h1v-5H6a2 2 0 0 0-2 2zM20 15a2 2 0 0 1-2 2h-1v-5h1a2 2 0 0 1 2 2z',
  headphonesOff: 'M3 3l18 18M4 15v-3a8 8 0 0 1 12-6.9M20 15v-3a8 8 0 0 0-.7-3.2M4 15a2 2 0 0 0 2 2h1v-5H6a2 2 0 0 0-2 2z',
  video: 'M15 10l5-3v10l-5-3M3 7h12v10H3z',
  videoOff: 'M3 3l18 18M15 10l5-3v10l-5-3M3 7h9M3 17h12V9',
  screen: 'M3 5h18v11H3zM8 20h8M12 16v4',
  settings: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  pin: 'M9 3h6v6l3 3H6l3-3V3zM12 12v9',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  send: 'M4 12l16-8-6 16-3-6-7-2z',
  reply: 'M9 7 4 12l5 5M4 12h9a6 6 0 0 1 6 6',
  edit: 'M4 20h4l10-10-4-4L4 16v4zM14 6l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  smile: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 14.5a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01',
  users: 'M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 20v-2a4 4 0 0 0-3-3.9M16 2.1a4 4 0 0 1 0 7.8',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  logout: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3',
  check: 'M20 6 9 17l-5-5',
  compass: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM16 8l-2.5 5.5L8 16l2.5-5.5L16 8z',
  message: 'M21 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v9z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5zM14 3v5h5',
  poll: 'M6 20V10M12 20V4M18 20v-7',
  calendar: 'M4 6h16v14H4zM8 3v4M16 3v4M4 11h16',
  ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.6 5.6l12.8 12.8',
  menu: 'M4 7h16M4 12h16M4 17h16',
  arrowLeft: 'M19 12H5M11 18l-6-6 6-6',
  more: 'M12 6h.01M12 12h.01M12 18h.01',
  link: 'M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1',
  phoneOff: 'M3 3l18 18M6.5 9.5A12 12 0 0 1 12 7c3 0 5.5 1 7.5 2.5 1 .8 1.3 2 .8 3l-.8 1.5c-.5 1-1.8 1.3-2.7.7l-1.5-1c-.7-.5-.9-1.4-.5-2.1M8 13l-1.5 1c-.9.6-2.2.3-2.7-.7L3 11.8',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  at: 'M16 12a4 4 0 1 1-4-4M20 12a8 8 0 1 0-3 6.2',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18',
  copy: 'M9 9h10v12H9zM5 15V3h10',
  crown: 'M3 8l4 3 5-6 5 6 4-3-2 11H5L3 8z',
  hammer: 'M14 3l7 7-3 3-7-7 3-3zM3 21l7-7M9 11l4 4',
};

export function Icon({
  name,
  size = 20,
  className,
  strokeWidth = 1.8,
}: {
  name: keyof typeof PATHS | string;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  const d = PATHS[name] ?? PATHS.hash;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}

/* ---------------------------------- yardımcı -------------------------------- */

export function initials(name: string): string {
  const clean = name.trim();
  if (!clean) return '?';
  const parts = clean.split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

export function statusClass(status: UserStatus | string | undefined): string {
  return `st-${status ?? 'offline'}`;
}

export const STATUS_LABELS: Record<string, string> = {
  online: 'Çevrimiçi',
  idle: 'Boşta',
  dnd: 'Rahatsız etme',
  offline: 'Çevrimdışı',
  invisible: 'Görünmez',
};

export function timeOfDay(ts: number): string {
  return new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

export function fullTime(ts: number): string {
  return new Date(ts).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });
}

export function dayLabel(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(date, today)) return 'Bugün';
  if (same(date, yesterday)) return 'Dün';
  return date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function relative(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'şimdi';
  if (mins < 60) return `${mins} dk önce`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} sa önce`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} gün önce`;
  return new Date(ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ----------------------------------- avatar --------------------------------- */

export function Avatar({
  user,
  size = 38,
  showStatus = false,
  square = false,
}: {
  user: Pick<PublicUser, 'displayName' | 'avatarColor' | 'avatarUrl'> & { status?: string };
  size?: number;
  showStatus?: boolean;
  square?: boolean;
}) {
  const style: React.CSSProperties = {
    width: size,
    height: size,
    background: user.avatarColor || '#7c5cff',
    fontSize: Math.max(11, Math.round(size * 0.38)),
    borderRadius: square ? Math.round(size * 0.28) : '50%',
  };
  return (
    <span className="avatar" style={style} aria-hidden="true">
      {user.avatarUrl ? <img src={user.avatarUrl} alt="" loading="lazy" /> : initials(user.displayName)}
      {showStatus ? <span className={`status-dot ${statusClass(user.status)}`} /> : null}
    </span>
  );
}

/* ----------------------------------- modal ---------------------------------- */

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, textarea, button, select')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="presentation">
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Kapat">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ---------------------------------- bildirim -------------------------------- */

type ToastKind = 'info' | 'success' | 'error';
interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastApi {
  push: (message: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastApi>({ push: () => undefined });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const push = useCallback((message: string, kind: ToastKind = 'info') => {
    counter.current += 1;
    const id = counter.current;
    setItems((prev) => [...prev.slice(-3), { id, message, kind }]);
    window.setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4800);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast ${item.kind}`}>
            <span style={{ flex: 1 }}>{item.message}</span>
            <button
              type="button"
              className="close"
              aria-label="Bildirimi kapat"
              onClick={() => setItems((prev) => prev.filter((t) => t.id !== item.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ---------------------------------- yardımcı -------------------------------- */

export function Spinner({ label = 'Yükleniyor…' }: { label?: string }) {
  return (
    <div className="loader">
      <span className="spinner" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  icon = 'compass',
  title,
  description,
  action,
}: {
  icon?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-inner">
        <div className="empty-icon">
          <Icon name={icon} size={28} />
        </div>
        <h3>{title}</h3>
        {description ? <p>{description}</p> : null}
        {action ? <div style={{ marginTop: 16 }}>{action}</div> : null}
      </div>
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      <span style={{ fontSize: 13.5 }}>{label}</span>
    </label>
  );
}

/** Metni güvenli biçimde bağlantı, etiket ve satır içi koda çevirir. */
export function renderContent(content: string): React.ReactNode {
  const tokens = content.split(/(https?:\/\/[^\s<]+|@[\w.-]{2,32}|#[\w-]{1,48}|`[^`]+`|\*\*[^*]+\*\*)/g);
  return tokens.map((token, index) => {
    if (!token) return null;
    if (/^https?:\/\//.test(token)) {
      const href = token.replace(/[.,;:)]+$/, '');
      return (
        <a key={index} href={href} target="_blank" rel="noopener noreferrer nofollow">
          {href}
        </a>
      );
    }
    if (/^@[\w.-]{2,32}$/.test(token)) {
      return (
        <span key={index} style={{ color: 'var(--brand-3)', background: 'rgba(34,211,238,0.12)', borderRadius: 4, padding: '0 3px' }}>
          {token}
        </span>
      );
    }
    if (/^#[\w-]{1,48}$/.test(token)) {
      return (
        <span key={index} style={{ color: 'var(--brand-2)' }}>
          {token}
        </span>
      );
    }
    if (/^`[^`]+`$/.test(token)) {
      return <code key={index}>{token.slice(1, -1)}</code>;
    }
    if (/^\*\*[^*]+\*\*$/.test(token)) {
      return <strong key={index}>{token.slice(2, -2)}</strong>;
    }
    return <React.Fragment key={index}>{token}</React.Fragment>;
  });
}

export const EMOJIS = ['👍', '❤️', '😂', '🎉', '🔥', '😮', '😢', '🙏', '✅', '👀', '🚀', '💜'];
