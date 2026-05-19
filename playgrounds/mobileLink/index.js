import { registerRootComponent } from 'expo'

const App =
  process.env.EXPO_PUBLIC_MOBILE_LINK_ROLE === 'host'
    ? require('./src/hostApp').default
    : require('./src/consumerApp').default

registerRootComponent(App)
