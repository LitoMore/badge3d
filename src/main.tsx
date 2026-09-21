import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {BadgeWorkshop} from './badge-workshop.js';
import './globals.css';

createRoot(document.querySelector('#root')!).render(
	<StrictMode>
		<BadgeWorkshop />
	</StrictMode>,
);
