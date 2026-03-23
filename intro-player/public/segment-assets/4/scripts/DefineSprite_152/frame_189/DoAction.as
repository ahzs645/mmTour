if(!_level0.timeMarkDone(_level0.bkgd.kioskModeWaitTime))
{
   gotoAndPlay(_currentframe - 1);
}
else
{
   _level0.bkgd.currScene = "SafeAndEasy";
   _level0.doRelease("segment1.swf");
}
