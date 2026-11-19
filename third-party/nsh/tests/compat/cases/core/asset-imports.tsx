import { Text, View } from "nsh";
import intro from "./media/intro.mp4";
import model from "./data/model.bin?url";

export default () => (
  <View style={{ flex: 1, paddingTop: 64 }}>
    <Text>{`Video: ${intro}`}</Text>
    <Text>{`File: ${model}`}</Text>
  </View>
);
