/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
import { host, mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { QuickToolsSurface } from '../../app/QuickTools';
import { currentLocale } from '../../app/locale';
mount(() => {
  const opened = signal(true);
  host.on('quickTools.visibility', (event) => opened.set((event as { visible: boolean }).visible));
  return (
    <View style={{ flex: 1 }}>
      <Button testID="english" onPress={() => currentLocale.set('en')}>
        <Text>English</Text>
      </Button>
      <Button testID="chinese" onPress={() => currentLocale.set('zh-CN')}>
        <Text>中文</Text>
      </Button>
      <Button testID="reopen" onPress={() => opened.set(true)}>
        <Text>Reopen</Text>
      </Button>
      <QuickToolsSurface
        opened={opened}
        close={() => opened.set(false)}
        openAssistant={async () => true}
      />
    </View>
  );
});
