/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        display: ['"Playfair Display"', 'Georgia', 'serif'],
        body: ['"Source Serif 4"', 'Charter', 'serif'],
        ui: ['"DM Sans"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      colors: {
        brand: {
          red: '#C2452D',
          'red-soft-light': '#FFF0ED',
          'red-soft-dark': '#2A1A16',
        },
        dark: {
          primary: '#141414',
          card: '#1E1E1E',
          surface: '#252525',
          border: '#2A2A2A',
          divider: '#222222',
        },
        light: {
          primary: '#FAFAF8',
          card: '#FFFFFF',
          surface: '#F2F0EC',
          border: '#E8E6E1',
          divider: '#F0EEEA',
        },
        'text-dark': {
          primary: '#EAEAEA',
          secondary: '#999999',
          tertiary: '#666666',
        },
        'text-light': {
          primary: '#1A1A1A',
          secondary: '#6B6B6B',
          tertiary: '#999999',
        },
        semantic: {
          error: '#E85D4A',
          success: '#3FB68B',
        },
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
