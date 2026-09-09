import { cx } from "../lib/cx.ts";
import { Icon } from "./Icon.tsx";
import styles from "./ui.module.css";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { IconName } from "./Icon.tsx";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "quiet" | "danger";
  icon?: IconName;
};

export function Button({ variant = "default", icon, children, className, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={cx(
        styles.button,
        variant === "primary" && styles.primary,
        variant === "quiet" && styles.quiet,
        variant === "danger" && styles.danger,
        className,
      )}
      {...rest}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  variant = "quiet",
  className,
  ...rest
}: Omit<ButtonProps, "icon" | "children"> & { icon: IconName; label: string }) {
  return (
    <Button
      variant={variant}
      icon={icon}
      aria-label={label}
      title={label}
      className={cx(styles.iconButton, className)}
      {...rest}
    />
  );
}

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className={styles.srOnly}>{children}</span>;
}

export function ProgressBar({ value, label }: { value: number | null; label: string }) {
  const percent = value === null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      className={cx(styles.progressTrack, percent === null && styles.progressIndeterminate)}
      role="progressbar"
      aria-label={label}
      {...(percent === null
        ? {}
        : { "aria-valuenow": percent, "aria-valuemin": 0, "aria-valuemax": 100 })}
    >
      <div
        className={styles.progressFill}
        style={percent === null ? {} : { width: `${percent}%` }}
      />
    </div>
  );
}

export function Skeleton({ height = 14, width = "100%" }: { height?: number; width?: string }) {
  return <div className={styles.skeleton} style={{ height, width }} aria-hidden="true" />;
}

export function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <div className={styles.skeletonStack}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={index === 0 ? 18 : 14} width={index === 0 ? "60%" : "100%"} />
      ))}
    </div>
  );
}
