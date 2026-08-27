import type { Locale } from '@platform/locale';
import { format, type Money } from '@platform/money';

/**
 * A price, optionally showing a struck-through "was" price.
 *
 * The was-price is marked up with <s> and given a visually-hidden label rather
 * than relying on the strikethrough alone. A screen reader announcing
 * "1,299.00 999.00" with no explanation is worse than useless when the number
 * is what the customer hands over in cash at the door.
 */
export const Price = ({
  amount,
  compareAt,
  locale,
  labelWas,
  labelNow,
  size = 'md',
}: {
  amount: Money;
  compareAt?: Money | null;
  locale: Locale;
  /** Translated "Was" / "Regular price". */
  labelWas: string;
  /** Translated "Now" / "Sale price". */
  labelNow: string;
  size?: 'sm' | 'md' | 'lg';
}) => {
  const scale = {
    sm: 'text-sm',
    md: 'text-lg',
    lg: 'text-3xl',
  }[size];

  const onOffer = compareAt !== undefined && compareAt !== null;

  return (
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      {onOffer && <span className="sr-only">{labelNow}</span>}
      <span className={`${scale} font-semibold tabular-nums text-ink`}>
        {format(amount, locale)}
      </span>
      {onOffer && (
        <>
          <span className="sr-only">{labelWas}</span>
          <s className="text-sm tabular-nums text-faint decoration-faint/60">
            {format(compareAt, locale)}
          </s>
        </>
      )}
    </p>
  );
};

/**
 * "From $1,199.00" for a product whose variants differ in price.
 *
 * The caller passes the sentence already interpolated, because "From {price}"
 * does not survive word-for-word translation — Arabic and French put the number
 * in a different place, and next-intl is the thing that knows where.
 */
export const PriceFrom = ({ label, size = 'md' }: { label: string; size?: 'sm' | 'md' | 'lg' }) => {
  const scale = { sm: 'text-sm', md: 'text-lg', lg: 'text-3xl' }[size];
  return <p className={`${scale} font-semibold tabular-nums text-ink`}>{label}</p>;
};
