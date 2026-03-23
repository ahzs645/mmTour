if(_level0.bkgd.OSVersion == "Per")
{
   timeMark = getTimer();
   holdTime = 2000;
   waitTime = timeMark + holdTime;
   do
   {
      currTime = getTimer();
   }
   while(currTime < waitTime);
   
   _level0.LoadInitialInteractive();
}
else
{
   gotoAndPlay(344);
}
