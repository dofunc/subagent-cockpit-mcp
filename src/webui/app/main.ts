import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import '@ant-design/x-markdown/themes/light.css'
import '@ant-design/x-markdown/themes/dark.css'
import './markdown.css'
import App from './App'

const container = document.createElement('div')
document.body.style.margin = '0'
document.body.appendChild(container)
createRoot(container).render(createElement(App))
