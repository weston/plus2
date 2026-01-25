'use client';

/* eslint-disable @next/next/no-img-element */

interface CountryFlagProps {
  country?: string | null;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

// Common countries list for the selector
export const COUNTRIES = [
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'JP', name: 'Japan' },
  { code: 'KR', name: 'South Korea' },
  { code: 'CN', name: 'China' },
  { code: 'BR', name: 'Brazil' },
  { code: 'MX', name: 'Mexico' },
  { code: 'ES', name: 'Spain' },
  { code: 'IT', name: 'Italy' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'PL', name: 'Poland' },
  { code: 'RU', name: 'Russia' },
  { code: 'IN', name: 'India' },
  { code: 'SE', name: 'Sweden' },
  { code: 'NO', name: 'Norway' },
  { code: 'DK', name: 'Denmark' },
  { code: 'FI', name: 'Finland' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'AT', name: 'Austria' },
  { code: 'BE', name: 'Belgium' },
  { code: 'PT', name: 'Portugal' },
  { code: 'IE', name: 'Ireland' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'SG', name: 'Singapore' },
  { code: 'HK', name: 'Hong Kong' },
  { code: 'TW', name: 'Taiwan' },
  { code: 'TH', name: 'Thailand' },
  { code: 'VN', name: 'Vietnam' },
  { code: 'PH', name: 'Philippines' },
  { code: 'MY', name: 'Malaysia' },
  { code: 'ID', name: 'Indonesia' },
  { code: 'AR', name: 'Argentina' },
  { code: 'CL', name: 'Chile' },
  { code: 'CO', name: 'Colombia' },
  { code: 'PE', name: 'Peru' },
  { code: 'ZA', name: 'South Africa' },
  { code: 'EG', name: 'Egypt' },
  { code: 'NG', name: 'Nigeria' },
  { code: 'IL', name: 'Israel' },
  { code: 'TR', name: 'Turkey' },
  { code: 'SA', name: 'Saudi Arabia' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'UA', name: 'Ukraine' },
  { code: 'CZ', name: 'Czech Republic' },
  { code: 'HU', name: 'Hungary' },
  { code: 'RO', name: 'Romania' },
  { code: 'GR', name: 'Greece' },
].sort((a, b) => a.name.localeCompare(b.name));

// Size configurations for flag images
// flagcdn supports: w20, w40, w80, w160, w320, w640
const SIZE_CONFIG = {
  sm: { width: 16, height: 12, cdnWidth: 20 },
  md: { width: 20, height: 15, cdnWidth: 40 },
  lg: { width: 28, height: 21, cdnWidth: 40 },
};

export function CountryFlag({ country, size = 'md', className = '' }: CountryFlagProps) {
  if (!country) return null;

  const countryLower = country.toLowerCase();
  const countryName = COUNTRIES.find(c => c.code === country.toUpperCase())?.name || country.toUpperCase();
  const { width, height, cdnWidth } = SIZE_CONFIG[size];

  // Use flagcdn.com for flag images (free, no API key needed)
  // flagcdn only supports specific widths: 20, 40, 80, 160, 320, 640
  const flagUrl = `https://flagcdn.com/w${cdnWidth}/${countryLower}.png`;

  return (
    <img
      src={flagUrl}
      alt={countryName}
      title={countryName}
      width={width}
      height={height}
      className={`inline-block ${className}`}
      style={{ objectFit: 'cover' }}
      loading="lazy"
    />
  );
}
