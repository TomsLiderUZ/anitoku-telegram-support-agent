import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './router/index';
import { ThemeManager } from './@theme/ThemeManager';
import './styles/colors.css';
import './styles/variables.css';
import './styles/globals.css';

// Applied before the first paint so the panel never flashes light then dark.
ThemeManager.init();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
