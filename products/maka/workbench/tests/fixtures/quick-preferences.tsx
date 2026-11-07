/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
import { mount, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { currentLocale } from '../../app/locale';
import { appearance, initializeAppearance } from '../../app/appearance';
import { initializeQuickPreferences } from '../../app/quickPreferences';
mount(() => {
  initializeAppearance();
  initializeQuickPreferences({
    locale: currentLocale,
    setLocale: (value) => currentLocale.set(value),
  });
  return (
    <View>
      <Text>
        {currentLocale()}|{appearance.theme()}|{appearance.palette()}
      </Text>
      <Button testID="chinese" onPress={() => currentLocale.set('zh-CN')}>
        <Text>中文</Text>
      </Button>
      <Button testID="english" onPress={() => currentLocale.set('en')}>
        <Text>English</Text>
      </Button>
      <Button testID="dark" onPress={() => appearance.chooseTheme('dark')}>
        <Text>Dark</Text>
      </Button>
      <Button testID="sage" onPress={() => appearance.choosePalette('sage')}>
        <Text>Sage</Text>
      </Button>
    </View>
  );
});
