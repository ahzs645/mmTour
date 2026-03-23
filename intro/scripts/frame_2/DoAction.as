function playVO(sndFileName, doRamp)
{
   if(!doRamp)
   {
      snd.s1.stop();
      snd.s1_playing = 0;
      snd.s2.stop();
      snd.s2_playing = 0;
      snd.s1.attachSound(sndFileName);
      snd.s1_playing = 1;
      snd.s1.setVolume = _level0.bkgd.VOvol;
      _level0.bkgd.vo.activeSnd = sndFileName;
      _level0.markSnd(sndFileName);
      snd.s1.start();
   }
   else if(snd.s1_playing)
   {
      snd.s2.attachSound(sndFileName);
      snd.s2_playing = 1;
      snd.s2.setVolume = _level0.bkgd.VOvol;
      snd.s2.start();
   }
   else if(snd.s2_playing)
   {
      snd.s1.attachSound(sndFileName);
      snd.s1_playing = 1;
      snd.s1.setVolume = _level0.bkgd.VOvol;
      snd.s1.start();
   }
}
var snd = new Object();
snd.s1 = new Sound(this);
snd.s2 = new Sound(this);
snd.fadeSnd = 0;
snd.s1_playing = 0;
snd.s2_playing = 0;
