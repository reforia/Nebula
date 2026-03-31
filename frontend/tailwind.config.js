/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        nebula: {
          bg: '#09090b',
          surface: '#121215',
          'surface-2': '#1a1a1f',
          border: '#222228',
          'border-light': '#2e2e36',
          hover: '#1a1a20',
          text: '#e8e6e3',
          muted: '#75726b',
          accent: '#c9a84c',
          'accent-dim': '#a68a3a',
          'accent-glow': 'rgba(201, 168, 76, 0.12)',
          gold: '#d4af37',
          'gold-dim': '#8b7524',
          'gold-pale': '#f5e6b8',
          green: '#5fba7d',
          red: '#e05252',
          amber: '#d4a03c',
        },
      },
      fontFamily: {
        sans: ['"Inter"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'monospace'],
      },
      boxShadow: {
        'glow': '0 0 20px rgba(201, 168, 76, 0.08)',
        'glow-lg': '0 0 40px rgba(201, 168, 76, 0.12)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
};
