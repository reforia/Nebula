/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        nebula: {
          bg: '#09090b',
          surface: '#121215',
          border: '#222228',
          hover: '#1a1a20',
          text: '#e8e6e3',
          muted: '#75726b',
          accent: '#c9a84c',
          green: '#5fba7d',
          red: '#e05252',
        },
      },
    },
  },
  plugins: [],
};
