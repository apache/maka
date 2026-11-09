/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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
