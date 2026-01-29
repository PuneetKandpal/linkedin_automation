import { useEffect, type PropsWithChildren, type ReactNode } from 'react';

export function Button(
  props: PropsWithChildren<{ onClick?: () => void; type?: 'button' | 'submit'; variant?: 'primary' | 'ghost' | 'danger'; disabled?: boolean }>
) {
  const { variant = 'primary' } = props;
  return (
    <button
      type={props.type || 'button'}
      onClick={props.onClick}
      disabled={props.disabled}
      data-variant={variant}
      className="btn"
    >
      {props.children}
    </button>
  );
}

export function Card(props: PropsWithChildren<{ title?: string; right?: ReactNode }>) {
  return (
    <section className="card">
      {(props.title || props.right) && (
        <header className="cardHeader">
          <div className="cardTitle">{props.title}</div>
          <div>{props.right}</div>
        </header>
      )}
      <div className="cardBody">{props.children}</div>
    </section>
  );
}

export function Field(
  props: PropsWithChildren<{ label: string; hint?: string; error?: string }>
) {
  return (
    <label className="field">
      <div className="fieldLabel">{props.label}</div>
      {props.children}
      {props.error ? <div className="fieldError">{props.error}</div> : null}
      {props.hint ? <div className="fieldHint">{props.hint}</div> : null}
    </label>
  );
}

export function InlineError(props: { message: string }) {
  return <div className="error">{props.message}</div>;
}

export function InlineSuccess(props: { message: string }) {
  return <div className="success">{props.message}</div>;
}

export function Note(props: { text: string }) {
  return (
    <div className="note">
      <div className="noteTitle">Note</div>
      <div className="noteBody">{props.text}</div>
    </div>
  );
}

export function Badge(props: { tone?: 'ok' | 'warn' | 'danger' | 'neutral' | 'info'; text: string }) {
  return (
    <span className={`badge badge-${props.tone || 'neutral'}`}>{props.text}</span>
  );
}

export function Modal(
  props: PropsWithChildren<{
    open: boolean;
    title?: string;
    onClose: () => void;
    footer?: ReactNode;
  }>
) {
  const { open, onClose, title, footer, children } = props;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modalOverlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modalHeader">
          <div className="modalTitle">{title}</div>
          <button className="modalClose" onClick={onClose} type="button">
            Close
          </button>
        </div>
        <div className="modalBody">{children}</div>
        {footer ? <div className="modalFooter">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Drawer(
  props: PropsWithChildren<{
    open: boolean;
    title?: string;
    onClose: () => void;
    footer?: ReactNode;
  }>
) {
  const { open, onClose, title, footer, children } = props;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="drawerOverlay" onMouseDown={onClose}>
      <div className="drawer" onMouseDown={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="drawerHeader">
          <div className="drawerTitle">{title}</div>
          <button className="drawerClose" onClick={onClose} type="button">
            Close
          </button>
        </div>
        <div className="drawerBody">{children}</div>
        {footer ? <div className="drawerFooter">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Loader(props: { label?: string }) {
  return (
    <div className="loaderWrap" role="status" aria-live="polite">
      <div className="loader" />
      <div className="loaderLabel">{props.label || 'Loading…'}</div>
    </div>
  );
}
