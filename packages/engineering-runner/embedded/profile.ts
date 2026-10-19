import { createHash } from 'node:crypto';

export const GESTURESCREEN_PROFILE = Object.freeze({
  schemaVersion: 1, id: 'gesturescreen-challenger-v1', revision: '1',
  adapterId: 'fixed-stm32-pyocd', chipTarget: 'STM32F429IGTx', target: 'GestureScreen',
  usbVid: '1FC9', usbPid: '5601', probeSerial: '594AC1D7613FED24',
  uid: '0037001b3133510432383236', chipId: 0x419, flashKiB: 1024,
  cdcVid: '0483', cdcPid: '5740', cdcSerial: '326F32513133',
  uvprojx: 'MDK-ARM/GestureScreen.uvprojx',
  uvprojxSha256: '32d523fa960ae727a05fdc9610c8ace2f6e8d1cd00a0417323a7cddb49aa2035',
  keilExecutable: 'D:/STSoft/Keil5/UV4/UV4.exe',
  keilSha256: '428baf13d15e6760af1618def9c9815c97f0321cc5e459ec7adc4dde41c42f89',
  templateManifestSha256: 'd69f4e175352d29669d262d92f3da77a3c877d3f0673681d685d4bc667cf04f7',
  toolHashes: {
    'ARM/ARMCLANG/bin/armclang.exe': 'ad5afaace02844fad6631ebe77d5a995a72f79555ebfa52ce969e735a4d46f91',
    'ARM/ARMCLANG/bin/armlink.exe': 'f63cf864edbf904e7db98647038ec8e75894a216c7fabc179277874ea6050f08',
    'ARM/ARMCLANG/bin/armasm.exe': '3b2c9a997453fbd5f88be730fe5eb553c1066982bbfe24bbe3436c02a4678895',
  },
  excludedPaths: ['.git', 'Build', 'MDK-ARM/Objects', 'MDK-ARM/Listings', 'demo/GestureScreen-demo-HQ.mp4'],
  limitation: 'Human-driven fixed-target workflow. No claim of model or OS account isolation.',
});

export const GESTURESCREEN_PROFILE_SHA256 = createHash('sha256').update(JSON.stringify(GESTURESCREEN_PROFILE)).digest('hex');
