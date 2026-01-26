import type { PropsWithChildren, ReactNode } from 'react';

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
  props: PropsWithChildren<{ label: string; hint?: string }>
) {
  return (
    <label className="field">
      <div className="fieldLabel">{props.label}</div>
      {props.children}
      {props.hint ? <div className="fieldHint">{props.hint}</div> : null}
    </label>
  );
}

export function InlineError(props: { message: string }) {
  return <div className="error">{props.message}</div>;
}

export function Badge(props: { tone?: 'ok' | 'warn' | 'danger' | 'neutral'; text: string }) {
  return (
    <span className={`badge badge-${props.tone || 'neutral'}`}>{props.text}</span>
  );
}
