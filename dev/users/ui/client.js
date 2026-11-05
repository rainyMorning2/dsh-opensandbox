window.__ModuleLoader__.load({
  id: '@codebam/dsh-user-ui',
  factory(require) {
    const { createElement: h } = require('react')
    const { Button, Tooltip } = require('@deepseek-ai/dsh-client-ui-primitives')
    function Logout({ wide, t }) {
      const icon = h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
        h('path', { d: 'M9 4H4v16h5M14 8l4 4-4 4M8 12h10', strokeLinecap: 'round', strokeLinejoin: 'round' }))
      return h(Tooltip, { label: t('logout'), disabled: wide },
        h(Button, { variant: 'ghost', size: 'sm', 'aria-label': t('logout'), onClick: () => { window.location.assign('/auth/logout') }, style: { width: '100%', justifyContent: wide ? 'flex-start' : 'center' } }, icon, wide ? t('logout') : null))
    }
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('deploymentUser', { en: { logout: 'Sign out' }, zh: { logout: '退出登录' } }), 'deployment user copy')
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'deployment-user-logout', locale: 'deploymentUser', order: 100 }, Logout))
      },
    }
  },
})
