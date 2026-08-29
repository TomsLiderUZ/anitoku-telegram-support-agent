/**
 * Routes.
 *
 * Pages are lazily loaded so the first paint is the shell, not the whole
 * panel; Suspense falls back to the same loading state pages use internally,
 * which keeps the transition from flashing.
 */
import { lazy, Suspense } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import MainLayout from '../layouts/index';
import { Loading } from '../components/Ui';

const page = (importer) => {
  const C = lazy(importer);
  return (
    <Suspense fallback={<Loading />}>
      <C />
    </Suspense>
  );
};

export const router = createBrowserRouter(
  [
    {
      path: '/',
      element: <MainLayout />,
      children: [
        { index: true, element: page(() => import('../pages/Dashboard')) },
        { path: 'chats', element: page(() => import('../pages/Chats')) },
        { path: 'assistant', element: page(() => import('../pages/Assistant')) },
        { path: 'tasks', element: page(() => import('../pages/Tasks')) },
        { path: 'projects', element: page(() => import('../pages/Projects')) },
        { path: 'code', element: page(() => import('../pages/Code')) },
        { path: 'knowledge', element: page(() => import('../pages/Knowledge')) },
        { path: 'models', element: page(() => import('../pages/Models')) },
        { path: 'settings', element: page(() => import('../pages/Settings')) },
        { path: '*', element: page(() => import('../pages/NotFound')) },
      ],
    },
  ],
  { basename: '/ui' }
);
