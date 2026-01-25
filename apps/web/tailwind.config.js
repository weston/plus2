/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // League colors
        bronze: '#CD7F32',
        silver: '#C0C0C0',
        gold: '#FFD700',
        platinum: '#E5E4E2',
        diamond: '#B9F2FF',
        master: '#FF6B6B',
        grandmaster: '#9B59B6',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'spin-slow': 'spin 3s linear infinite',
      },
    },
  },
  plugins: [],
};
